import type { K8sClient } from "./k8s-client.js";

let reaperInterval: ReturnType<typeof setInterval> | null = null;

export function startIdleReaper(client: K8sClient, namespace: string, idleTimeoutMin: number): void {
  if (reaperInterval) return;

  const checkIntervalMs = 60_000; // check every minute
  const idleThresholdMs = idleTimeoutMin * 60 * 1000;

  reaperInterval = setInterval(async () => {
    try {
      const pods = await client.listSandboxPods(namespace);
      const now = Date.now();

      for (const pod of pods) {
        const lastExec = pod.metadata?.annotations?.["paperclip.inc/last-exec"];
        if (!lastExec) continue;

        const elapsed = now - new Date(lastExec).getTime();
        if (elapsed > idleThresholdMs) {
          const podName = pod.metadata?.name;
          if (podName) {
            await client.deletePod(podName, namespace);
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
