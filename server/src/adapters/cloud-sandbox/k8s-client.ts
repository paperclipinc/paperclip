import * as k8s from "@kubernetes/client-node";
import { PassThrough } from "node:stream";

export interface PersistenceOptions {
  pvcName: string;
  storageClass?: string;
  size: string;
}

export interface SandboxPodOptions {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  image: string;
  env: Array<{ name: string; value: string }>;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  persistence?: PersistenceOptions;
  nodeSelector?: Record<string, string>;
  tolerations?: Array<{ key: string; operator?: string; value?: string; effect?: string }>;
}

export interface ExecOptions {
  podName: string;
  namespace: string;
  command: string[];
  env?: Record<string, string>;
  stdin?: string;
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  timedOut: boolean;
}

/**
 * Check whether a Kubernetes API error is a 404 Not Found.
 * In @kubernetes/client-node v1.4.0 errors are thrown as ApiException
 * with a numeric `code` property.
 */
function isNotFound(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err) {
    return (err as { code: number }).code === 404;
  }
  return false;
}

export class K8sClient {
  private coreApi: k8s.CoreV1Api;
  private networkingApi: k8s.NetworkingV1Api;
  private kc: k8s.KubeConfig;

  constructor() {
    this.kc = new k8s.KubeConfig();
    try {
      this.kc.loadFromCluster();
    } catch {
      this.kc.loadFromDefault();
    }
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
  }

  async getPod(name: string, namespace: string): Promise<k8s.V1Pod | null> {
    try {
      return await this.coreApi.readNamespacedPod({ name, namespace });
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async createPod(opts: SandboxPodOptions): Promise<k8s.V1Pod> {
    // When persistence is enabled, ensure the PVC exists before creating the pod
    if (opts.persistence) {
      await this.ensurePVC({
        name: opts.persistence.pvcName,
        namespace: opts.namespace,
        storageClass: opts.persistence.storageClass,
        size: opts.persistence.size,
        labels: opts.labels,
      });
    }

    const workspacesVolume: k8s.V1Volume = opts.persistence
      ? { name: "workspaces", persistentVolumeClaim: { claimName: opts.persistence.pvcName } }
      : { name: "workspaces", emptyDir: {} };

    const pod: k8s.V1Pod = {
      metadata: {
        name: opts.name,
        namespace: opts.namespace,
        labels: opts.labels,
        annotations: {
          "paperclip.inc/last-exec": new Date().toISOString(),
        },
      },
      spec: {
        containers: [
          {
            name: "sandbox",
            image: opts.image,
            command: ["sleep", "infinity"],
            env: opts.env,
            resources: opts.resources ? {
              requests: opts.resources.requests,
              limits: opts.resources.limits,
            } : {
              requests: { cpu: "500m", memory: "1Gi" },
              limits: { cpu: "4", memory: "8Gi" },
            },
            volumeMounts: [
              { name: "workspaces", mountPath: "/workspaces" },
              { name: "agent-homes", mountPath: "/home/agents" },
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              runAsNonRoot: true,
              runAsUser: 1000,
              readOnlyRootFilesystem: false,
              capabilities: { drop: ["ALL"] },
              seccompProfile: { type: "RuntimeDefault" },
            },
          },
        ],
        volumes: [
          workspacesVolume,
          { name: "agent-homes", emptyDir: {} },
        ],
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        ...(opts.nodeSelector ? { nodeSelector: opts.nodeSelector } : {}),
        ...(opts.tolerations ? { tolerations: opts.tolerations } : {}),
      },
    };

    return await this.coreApi.createNamespacedPod({ namespace: opts.namespace, body: pod });
  }

  async ensurePod(opts: SandboxPodOptions): Promise<k8s.V1Pod> {
    const existing = await this.getPod(opts.name, opts.namespace);
    if (existing && existing.status?.phase !== "Failed" && existing.status?.phase !== "Succeeded") {
      return existing;
    }
    if (existing) {
      await this.deletePod(opts.name, opts.namespace);
    }
    return this.createPod(opts);
  }

  async deletePod(name: string, namespace: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 10 });
    } catch (err: unknown) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async waitForReady(name: string, namespace: string, timeoutMs: number = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pod = await this.getPod(name, namespace);
      if (pod?.status?.phase === "Running") {
        const ready = pod.status.containerStatuses?.every((cs) => cs.ready);
        if (ready) return;
      }
      if (pod?.status?.phase === "Failed" || pod?.status?.phase === "Succeeded") {
        throw new Error(`Sandbox pod ${name} entered terminal phase: ${pod.status.phase}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Sandbox pod ${name} not ready within ${timeoutMs}ms`);
  }

  async exec(opts: ExecOptions): Promise<ExecResult> {
    const exec = new k8s.Exec(this.kc);

    // Build the command: inject env vars into the shell command
    let shellCommand: string[];
    if (opts.env && Object.keys(opts.env).length > 0) {
      const envExports = Object.entries(opts.env)
        .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
        .join(" && ");
      // If the command is already ["sh", "-c", "..."], prepend env exports to the inner script
      if (opts.command[0] === "sh" && opts.command[1] === "-c" && opts.command.length === 3) {
        shellCommand = ["sh", "-c", `${envExports} && ${opts.command[2]}`];
      } else {
        shellCommand = ["sh", "-c", `${envExports} && ${opts.command.join(" ")}`];
      }
    } else {
      shellCommand = opts.command;
    }

    return new Promise<ExecResult>((resolve, reject) => {
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true;
          resolve({ exitCode: -1, timedOut: true });
        }, opts.timeoutMs);
      }

      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();

      stdoutStream.on("data", (chunk: Buffer) => opts.onStdout(chunk.toString()));
      stderrStream.on("data", (chunk: Buffer) => opts.onStderr(chunk.toString()));

      // Build a Readable for stdin if provided
      let stdinStream: PassThrough | null = null;
      if (opts.stdin) {
        stdinStream = new PassThrough();
        stdinStream.end(Buffer.from(opts.stdin));
      }

      exec.exec(
        opts.namespace,
        opts.podName,
        "sandbox",
        shellCommand,
        stdoutStream,
        stderrStream,
        stdinStream,
        false,
        (status: k8s.V1Status) => {
          if (timer) clearTimeout(timer);
          if (timedOut) return;
          const exitCode = status.status === "Success" ? 0 : 1;
          resolve({ exitCode, timedOut: false });
        },
      ).catch((err) => {
        if (timer) clearTimeout(timer);
        if (!timedOut) reject(err);
      });
    });
  }

  async updateLastExecAnnotation(name: string, namespace: string): Promise<void> {
    try {
      const patchBody = {
        metadata: {
          annotations: {
            "paperclip.inc/last-exec": new Date().toISOString(),
          },
        },
      };
      await this.coreApi.patchNamespacedPod(
        { name, namespace, body: patchBody },
        k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
      );
    } catch {
      // Non-critical — idle reaper will use a longer timeout
    }
  }

  async listSandboxPods(namespace: string): Promise<k8s.V1Pod[]> {
    const result = await this.coreApi.listNamespacedPod({
      namespace,
      labelSelector: "paperclip.inc/role=agent-sandbox",
    });
    return result.items;
  }

  async ensurePVC(opts: { name: string; namespace: string; storageClass?: string; size: string; labels: Record<string, string> }): Promise<void> {
    try {
      await this.coreApi.readNamespacedPersistentVolumeClaim({ name: opts.name, namespace: opts.namespace });
      // PVC already exists
      return;
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err;
    }

    const pvc: k8s.V1PersistentVolumeClaim = {
      metadata: {
        name: opts.name,
        namespace: opts.namespace,
        labels: opts.labels,
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: { storage: opts.size },
        },
        ...(opts.storageClass ? { storageClassName: opts.storageClass } : {}),
      },
    };

    await this.coreApi.createNamespacedPersistentVolumeClaim({ namespace: opts.namespace, body: pvc });
  }

  async deletePVC(name: string, namespace: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedPersistentVolumeClaim({ name, namespace });
    } catch (err: unknown) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async ensureNamespace(name: string, labels: Record<string, string>): Promise<void> {
    try {
      await this.coreApi.readNamespace({ name });
      // Namespace already exists
      return;
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err;
    }

    const ns: k8s.V1Namespace = {
      metadata: {
        name,
        labels,
      },
    };

    await this.coreApi.createNamespace({ body: ns });
  }

  /**
   * Ensures a NetworkPolicy exists that restricts sandbox pod egress to:
   * - DNS (port 53 UDP/TCP)
   * - HTTPS (port 443 TCP) — LLM APIs, git, package registries
   * - Paperclip server service (port 3100 TCP)
   * Blocks all ingress (sandbox pods don't serve traffic).
   */
  async ensureSandboxNetworkPolicy(namespace: string, serverServiceName: string): Promise<void> {
    const name = "paperclip-sandbox-policy";
    const policy: k8s.V1NetworkPolicy = {
      metadata: { name, namespace },
      spec: {
        podSelector: {
          matchLabels: { "paperclip.inc/role": "agent-sandbox" },
        },
        policyTypes: ["Ingress", "Egress"],
        ingress: [], // deny all ingress
        egress: [
          // DNS
          {
            ports: [
              { port: 53, protocol: "UDP" },
              { port: 53, protocol: "TCP" },
            ],
          },
          // HTTPS — LLM APIs, git clone, npm/go install
          {
            ports: [{ port: 443, protocol: "TCP" }],
          },
          // HTTP — some registries use port 80
          {
            ports: [{ port: 80, protocol: "TCP" }],
          },
          // SSH — git clone via SSH
          {
            ports: [{ port: 22, protocol: "TCP" }],
          },
          // Paperclip server API
          {
            to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "paperclip" } } }],
            ports: [{ port: 3100, protocol: "TCP" }],
          },
        ],
      },
    };

    try {
      await this.networkingApi.readNamespacedNetworkPolicy({ name, namespace });
      // Already exists — patch it
      await this.networkingApi.replaceNamespacedNetworkPolicy({ name, namespace, body: policy });
    } catch (err: unknown) {
      if (isNotFound(err)) {
        await this.networkingApi.createNamespacedNetworkPolicy({ namespace, body: policy });
      } else {
        throw err;
      }
    }
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
