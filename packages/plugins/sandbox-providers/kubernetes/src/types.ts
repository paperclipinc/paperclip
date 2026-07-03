import { z } from "zod";
import { adapterRegistrySchema } from "./adapter-registry.js";
import { KNOWN_ADAPTER_TYPES } from "./adapter-defaults.js";

const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

export const kubernetesProviderConfigSchema = z
  .object({
    inCluster: z.boolean().default(false),
    kubeconfig: z.string().optional(),

    namespacePrefix: z.string().regex(/^[a-z0-9-]{1,32}$/).default("paperclip-"),
    companySlug: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),

    imageRegistry: z.string().url().optional(),
    imageAllowList: z.array(z.string()).default([]),
    imagePullSecrets: z.array(z.string()).default([]),

    egressAllowFqdns: z.array(z.string()).default([]),
    egressAllowCidrs: z.array(z.string().regex(cidrRegex, "Invalid CIDR")).default([]),
    egressMode: z.enum(["cilium", "standard"]).default("standard"),

    defaultResources: z
      .object({
        requests: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
        limits: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
      })
      .optional(),

    runtimeClassName: z.string().optional(),
    serviceAccountAnnotations: z.record(z.string()).default({}),

    jobTtlSecondsAfterFinished: z.number().int().nonnegative().default(900),
    podActivityDeadlineSec: z.number().int().positive().default(3600),

    /**
     * How long a sandbox pod may sit with PodScheduled=False reason
     * Unschedulable before the readiness wait fails fast with a distinct
     * scheduling error (sandbox-cr backend only). A pod the scheduler cannot
     * place (cluster out of capacity, autoscaler outage) will never become
     * Ready by waiting inside the same exec budget; the grace period only
     * absorbs normal autoscaler scale-up latency.
     */
    podUnschedulableGraceSec: z.number().int().positive().default(120),

    /**
     * The adapter type that Jobs in this environment will run.
     * Each Kubernetes environment is bound to one adapter; create multiple
     * environments for different adapters.
     * Defaults to `"claude_local"`.
     */
    adapterType: z
      .string()
      .default("claude_local")
      .refine((v) => KNOWN_ADAPTER_TYPES.has(v), {
        message: "adapterType must be one of the known adapter types",
      }),

    /**
     * Optional declarative adapter registry. When present it is authoritative
     * for runtime image / envKeys / allowFqdns / probe / defaultEnv resolution
     * (replace semantics). Absent = built-in defaults.
     */
    adapters: adapterRegistrySchema.optional(),

    /**
     * Optional cloud control-plane URL for resolving a per-company inference
     * key (Bifrost virtual key). When set, the plugin resolves the company's
     * own virtual key from the control-plane immediately before writing the
     * per-run Secret and overrides the secret inference auth env vars
     * (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) with it, so each
     * company's runs use a key scoped to that company (separate cache bucket /
     * spend ledger). Resolution is FAIL-CLOSED: if this is configured but the
     * control-plane call fails or returns no key, the lease is rejected — the
     * run is NEVER allowed to fall back to the shared platform key (which would
     * place it in the shared inference cache bucket = a cross-tenant leak).
     *
     * The control-plane must expose `POST <url>/internal/bifrost-key` accepting
     * JSON `{ "companyId": "<id>" }` and returning `200 { "keyValue": "<vk>" }`.
     *
     * When UNSET (OSS / local / non-cloud), the plugin behaves exactly as
     * before: the inherited process-env keys (the shared platform key, if any)
     * are used unchanged. This keeps the per-company behavior strictly
     * cloud-gated and upstream-safe.
     */
    cloudInferenceKeyResolverUrl: z.string().url().optional(),

    /**
     * The sandbox backend to use.
     *
     * - `"sandbox-cr"` (default, alpha) — uses the kubernetes-sigs/agent-sandbox
     *   Sandbox CRD (agents.x-k8s.io/v1alpha1). Creates a long-lived pod that
     *   paperclip-server can exec into for multi-command adapter-install workflows.
     *   Requires the agent-sandbox controller to be installed in the cluster.
     *
     * - `"job"` — uses batch/v1 Job (stable fallback). One-shot entrypoint; does
     *   NOT support multi-command exec. Use this for clusters without agent-sandbox
     *   installed, or when you need stable (non-alpha) k8s APIs.
     */
    backend: z.enum(["sandbox-cr", "job"]).default("sandbox-cr"),
  })
  .refine(
    (cfg) => cfg.inCluster || cfg.kubeconfig,
    {
      message:
        "kubernetes provider requires one of `inCluster` or `kubeconfig`",
    },
  );

export type KubernetesProviderConfig = z.infer<typeof kubernetesProviderConfigSchema>;

export function parseKubernetesProviderConfig(input: unknown): KubernetesProviderConfig {
  return kubernetesProviderConfigSchema.parse(input);
}

export interface KubernetesLeaseMetadata {
  namespace: string;
  /** Name of the workload resource (Job name for job backend, Sandbox CR name for sandbox-cr backend). */
  jobName: string;
  podName: string | null;
  secretName: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed";
  /** Which backend provisioned this lease. */
  backend: "sandbox-cr" | "job";
  /**
   * Realized workspace cwd for this lease (e.g. "/workspace"), set at lease
   * acquisition. Lets the execution target resolve the correct cwd from the
   * lease itself, matching the SSH/Daytona providers. Optional for backward
   * compatibility with leases acquired before this field existed.
   */
  remoteCwd?: string;
}
