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

  // Check that the namespace env var or config is set
  const namespace = (config.namespace as string) || process.env.PAPERCLIP_CLOUD_SANDBOX_NAMESPACE || "";
  if (!namespace) {
    checks.push({
      code: "cloud_sandbox_namespace_missing",
      level: "warn",
      message: "No namespace configured; will default to \"default\".",
      hint: "Set PAPERCLIP_CLOUD_SANDBOX_NAMESPACE or adapterConfig.namespace.",
    });
  } else {
    checks.push({
      code: "cloud_sandbox_namespace_configured",
      level: "info",
      message: `Target namespace: ${namespace}`,
    });
  }

  // Check runtime image
  const image = (config.runtimeImage as string) || process.env.PAPERCLIP_CLOUD_SANDBOX_DEFAULT_IMAGE || "";
  if (!image) {
    checks.push({
      code: "cloud_sandbox_image_missing",
      level: "warn",
      message: "No runtime image configured; will default to ghcr.io/paperclipinc/agent-multi:latest.",
      hint: "Set PAPERCLIP_CLOUD_SANDBOX_DEFAULT_IMAGE or adapterConfig.runtimeImage.",
    });
  } else {
    checks.push({
      code: "cloud_sandbox_image_configured",
      level: "info",
      message: `Runtime image: ${image}`,
    });
  }

  // Check K8s connectivity by attempting to load config
  try {
    // Dynamic import so the test doesn't fail at import-time if the k8s
    // client-node package is missing (it's only needed at runtime).
    const { K8sClient } = await import("./k8s-client.js");
    const client = new K8sClient();
    const ns = namespace || "default";
    // Attempt to list pods to verify API access
    await client.listSandboxPods(ns);
    checks.push({
      code: "cloud_sandbox_k8s_reachable",
      level: "info",
      message: "Kubernetes API is reachable and authorized.",
    });
  } catch (err) {
    checks.push({
      code: "cloud_sandbox_k8s_unreachable",
      level: "error",
      message: err instanceof Error ? err.message : "Cannot reach Kubernetes API.",
      hint: "Ensure the server is running in-cluster with a valid ServiceAccount or has a local kubeconfig.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
