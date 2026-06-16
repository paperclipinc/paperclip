import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the cluster-touching collaborators so onEnvironmentAcquireLease runs in
// isolation. We capture the adapterEnv handed to createPerRunSecret — that is
// exactly what becomes the per-run Secret the agent pod reads for inference auth.
const h = vi.hoisted(() => ({
  createdSecretInputs: [] as Array<{ adapterEnv: Record<string, string> }>,
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));

vi.mock("../../src/tenant-orchestrator.js", () => ({
  ensureTenant: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/sandbox-cr-orchestrator.js", () => ({
  sandboxCrOrchestrator: {
    claim: vi.fn().mockResolvedValue({ uid: "uid-1" }),
    findPod: vi.fn().mockResolvedValue("pc-pod"),
  },
  SandboxCrTimeoutError: class SandboxCrTimeoutError extends Error {},
}));

vi.mock("../../src/job-orchestrator.js", () => ({
  jobOrchestrator: {
    claim: vi.fn().mockResolvedValue({ uid: "uid-1" }),
    findPod: vi.fn().mockResolvedValue("pc-pod"),
  },
  JobTimeoutError: class JobTimeoutError extends Error {},
}));

vi.mock("../../src/secret-manager.js", () => ({
  createPerRunSecret: vi.fn(async (_clients: unknown, input: { adapterEnv: Record<string, string> }) => {
    h.createdSecretInputs.push({ adapterEnv: input.adapterEnv });
  }),
}));

import plugin from "../../src/plugin.js";
import { __resetInferenceKeyCache } from "../../src/inference-key-resolver.js";

const RESOLVER_URL = "http://control-plane.svc:8080";

function acquireParams(config: Record<string, unknown>) {
  return {
    driverKey: "kubernetes",
    companyId: "acme-co",
    environmentId: "env-1",
    runId: "run-abc",
    config,
    // claude_local (default adapter) authenticates with ANTHROPIC_API_KEY.
    adapterType: "claude_local",
  } as never;
}

let savedAnthropicKey: string | undefined;

beforeEach(() => {
  h.createdSecretInputs = [];
  __resetInferenceKeyCache();
  savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
  // The single shared platform virtual key that lives in the worker's env.
  process.env.ANTHROPIC_API_KEY = "shared-platform-vk";
});

afterEach(() => {
  // Only undo the per-test fetch spy; leave the module mocks (claim/findPod/…)
  // intact — restoreAllMocks would reset their mockResolvedValue impls.
  vi.unstubAllGlobals();
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
});

describe("onEnvironmentAcquireLease — per-company inference key", () => {
  it("(a) configured + control-plane returns a key → per-run env uses the COMPANY vk", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keyValue: "vk-acme-co" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await plugin.definition.onEnvironmentAcquireLease!(
      acquireParams({ inCluster: true, backend: "sandbox-cr", cloudInferenceKeyResolverUrl: RESOLVER_URL }),
    );

    expect(h.createdSecretInputs).toHaveLength(1);
    expect(h.createdSecretInputs[0].adapterEnv.ANTHROPIC_API_KEY).toBe("vk-acme-co");
    // companyId is POSTed to the resolver endpoint.
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${RESOLVER_URL}/internal/bifrost-key`);
    expect(JSON.parse(init.body as string)).toEqual({ companyId: "acme-co" });
  });

  it("(b) configured + control-plane fails → THROWS, no shared fallback, no Secret written", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );

    await expect(
      plugin.definition.onEnvironmentAcquireLease!(
        acquireParams({ inCluster: true, backend: "sandbox-cr", cloudInferenceKeyResolverUrl: RESOLVER_URL }),
      ),
    ).rejects.toThrow(/returned 500/);

    // Fail-closed: the run never reaches createPerRunSecret with the shared key.
    expect(h.createdSecretInputs).toHaveLength(0);
  });

  it("(c) unconfigured → uses inherited env (shared key) unchanged, no control-plane call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await plugin.definition.onEnvironmentAcquireLease!(
      acquireParams({ inCluster: true, backend: "sandbox-cr" }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.createdSecretInputs).toHaveLength(1);
    expect(h.createdSecretInputs[0].adapterEnv.ANTHROPIC_API_KEY).toBe("shared-platform-vk");
  });
});
