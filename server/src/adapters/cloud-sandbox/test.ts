import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { parseObject } from "../utils.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const namespace = (config.namespace as string) || process.env.PAPERCLIP_CLOUD_SANDBOX_NAMESPACE || "default";
  const image = (config.runtimeImage as string) || process.env.PAPERCLIP_CLOUD_SANDBOX_DEFAULT_IMAGE || "ghcr.io/paperclipinc/agent-multi:latest";

  if (!namespace || namespace === "default") {
    checks.push({
      code: "cloud_sandbox_namespace_missing",
      level: "warn",
      message: "No dedicated namespace configured for sandbox pods.",
      hint: "Set PAPERCLIP_CLOUD_SANDBOX_NAMESPACE.",
    });
  }

  // Verify the sandbox runtime is reachable
  try {
    const { K8sClient } = await import("./k8s-client.js");
    const client = new K8sClient();
    await client.listSandboxPods(namespace);
    checks.push({
      code: "cloud_sandbox_ready",
      level: "info",
      message: "Cloud sandbox is configured and ready.",
    });
  } catch (err) {
    checks.push({
      code: "cloud_sandbox_unreachable",
      level: "error",
      message: "Cloud sandbox is not reachable. Agent runs may fail.",
      hint: err instanceof Error ? err.message : "Check server logs for details.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
