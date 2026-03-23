import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { K8sClient } from "./k8s-client.js";

let sharedClient: K8sClient | null = null;

function getClient(): K8sClient {
  if (!sharedClient) sharedClient = new K8sClient();
  return sharedClient;
}

function parseConfig(config: Record<string, unknown>) {
  return {
    runtime: (config.runtime as string) || "multi",
    model: (config.model as string) || "",
    image: (config.runtimeImage as string) || process.env.PAPERCLIP_CLOUD_SANDBOX_DEFAULT_IMAGE || "ghcr.io/paperclipinc/agent-multi:latest",
    isolation: (config.isolation as string) || "shared",
    namespace: process.env.PAPERCLIP_CLOUD_SANDBOX_NAMESPACE || "default",
    timeoutSec: (config.timeoutSec as number) || 600,
    resources: config.resources as { cpu?: string; memory?: string } | undefined,
    env: (config.env as Record<string, string>) || {},
  };
}

function podName(companyId: string, agentId: string, isolation: string): string {
  const id = isolation === "isolated" ? agentId : companyId;
  return `pci-sandbox-${id.slice(0, 8)}`;
}

function resolveRuntimeCommand(runtime: string, model: string): string[] {
  switch (runtime) {
    case "claude":
      return ["claude", "--print", "-", "--output-format", "stream-json", "--verbose",
        ...(model ? ["--model", model] : []),
        "--dangerously-skip-permissions"];
    case "codex":
      return ["codex", "--full-auto",
        ...(model ? ["--model", model] : [])];
    case "opencode":
      return ["opencode"];
    default:
      // multi — default to claude
      return ["claude", "--print", "-", "--output-format", "stream-json", "--verbose",
        "--dangerously-skip-permissions"];
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const client = getClient();
  const config = parseConfig(ctx.config);
  const companyId = ctx.agent.companyId;
  const agentId = ctx.agent.id;
  const name = podName(companyId, agentId, config.isolation);

  // Determine workspace cwd inside the pod
  const workspace = ctx.context.paperclipWorkspace as { cwd?: string; projectId?: string } | undefined;
  const projectId = workspace?.projectId || "default";
  const podCwd = `/workspaces/${projectId}`;

  // Labels for pod management
  const labels: Record<string, string> = {
    "paperclip.inc/role": "agent-sandbox",
    "paperclip.inc/company-id": companyId,
  };
  if (config.isolation === "isolated") {
    labels["paperclip.inc/agent-id"] = agentId;
  }

  // Company-level env vars (shared by all agents in the pod)
  const podEnv: Array<{ name: string; value: string }> = [
    { name: "PAPERCLIP_API_URL", value: process.env.PAPERCLIP_API_URL || "" },
    { name: "PAPERCLIP_COMPANY_ID", value: companyId },
  ];
  // Add resolved env config (LLM keys, connection tokens, secrets)
  for (const [key, value] of Object.entries(config.env)) {
    if (typeof value === "string") {
      podEnv.push({ name: key, value });
    }
  }

  // Ensure the sandbox pod exists
  try {
    await client.ensurePod({
      name,
      namespace: config.namespace,
      labels,
      image: config.image,
      env: podEnv,
      resources: config.resources ? {
        requests: { cpu: config.resources.cpu || "500m", memory: config.resources.memory || "1Gi" },
        limits: { cpu: config.resources.cpu || "4", memory: config.resources.memory || "8Gi" },
      } : undefined,
    });

    await client.waitForReady(name, config.namespace);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create sandbox pod";
    await ctx.onLog("stderr", `[cloud-sandbox] ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
    };
  }

  // Per-exec env overrides (agent-specific, not shared)
  const execEnv: Record<string, string> = {
    PAPERCLIP_AGENT_ID: agentId,
    PAPERCLIP_RUN_ID: ctx.runId,
    HOME: `/home/agents/${agentId}`,
  };

  // Build the CLI command
  const command = resolveRuntimeCommand(config.runtime, config.model);

  // Ensure agent home and workspace directories exist, then exec the CLI
  const setupAndRun = [
    `mkdir -p /home/agents/${agentId}`,
    `mkdir -p ${podCwd}`,
    `cd ${podCwd}`,
    command.join(" "),
  ].join(" && ");

  await ctx.onLog("stdout", `[cloud-sandbox] Executing in pod ${name} (ns: ${config.namespace})\n`);

  let exitCode = -1;
  let timedOut = false;

  try {
    const result = await client.exec({
      podName: name,
      namespace: config.namespace,
      command: ["sh", "-c", setupAndRun],
      env: execEnv,
      stdin: ctx.context.prompt as string | undefined,
      onStdout: (data) => { void ctx.onLog("stdout", data); },
      onStderr: (data) => { void ctx.onLog("stderr", data); },
      timeoutMs: config.timeoutSec * 1000,
    });
    exitCode = result.exitCode;
    timedOut = result.timedOut;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Exec failed";
    await ctx.onLog("stderr", `[cloud-sandbox] ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
    };
  }

  // Update last-exec annotation for idle reaper
  void client.updateLastExecAnnotation(name, config.namespace);

  return {
    exitCode,
    signal: null,
    timedOut,
    errorMessage: timedOut ? `Execution timed out after ${config.timeoutSec}s` : null,
  };
}
