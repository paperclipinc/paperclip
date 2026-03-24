import type { K8sClient } from "./k8s-client.js";

let reaperInterval: ReturnType<typeof setInterval> | null = null;

export interface IdleReaperOptions {
  client: K8sClient;
  namespace: string;
  idleTimeoutMin: number;
  /** When true, delete PVCs associated with reaped pods. Default: false (retain PVCs). */
  deletePVCs?: boolean;
}

export function startIdleReaper(opts: IdleReaperOptions): void;
export function startIdleReaper(client: K8sClient, namespace: string, idleTimeoutMin: number): void;
export function startIdleReaper(
  clientOrOpts: K8sClient | IdleReaperOptions,
  namespace?: string,
  idleTimeoutMin?: number,
): void {
  if (reaperInterval) return;

  const opts: IdleReaperOptions = typeof namespace === "string"
    ? { client: clientOrOpts as K8sClient, namespace, idleTimeoutMin: idleTimeoutMin! }
    : clientOrOpts as IdleReaperOptions;

  const checkIntervalMs = 60_000; // check every minute
  const idleThresholdMs = opts.idleTimeoutMin * 60 * 1000;

  reaperInterval = setInterval(async () => {
    try {
      const pods = await opts.client.listSandboxPods(opts.namespace);
      const now = Date.now();

      for (const pod of pods) {
        const lastExec = pod.metadata?.annotations?.["paperclip.inc/last-exec"];
        if (!lastExec) continue;

        const elapsed = now - new Date(lastExec).getTime();
        if (elapsed > idleThresholdMs) {
          const podName = pod.metadata?.name;
          const podNamespace = pod.metadata?.namespace || opts.namespace;
          if (podName) {
            await opts.client.deletePod(podName, podNamespace);

            // Optionally clean up associated PVCs
            if (opts.deletePVCs) {
              const pvcName = `pci-ws-${podName}`;
              await opts.client.deletePVC(pvcName, podNamespace).catch(() => {
                // PVC may not exist (e.g., persistence was never enabled for this pod)
              });
            }
          }
        }
      }
    } catch {
      // Log but don't crash the reaper
    }
  }, checkIntervalMs);
}

export function stopIdleReaper(): void {
  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
  }
}
