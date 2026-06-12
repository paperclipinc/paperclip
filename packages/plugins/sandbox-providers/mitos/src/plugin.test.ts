import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plugin from "./plugin.js";

// ---------------------------------------------------------------------------
// A small in-memory mock of the sandbox-server REST API, driven through a
// stubbed global fetch. We never stand up a real server, and the per-sandbox
// bearer token is asserted only by presence/shape, never printed.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  pathname: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

interface MockServerOptions {
  /** Template ids the server knows about. */
  templates?: string[];
  /** When set, the fork response includes this per-sandbox token. */
  forkToken?: string;
  /** Health payload overrides. */
  health?: Record<string, unknown>;
  /** Live sandbox ids returned from GET /v1/sandboxes. */
  liveSandboxes?: string[];
  /** Exec response. */
  exec?: { exit_code: number; stdout: string; stderr: string };
}

function installMockServer(options: MockServerOptions = {}) {
  const requests: RecordedRequest[] = [];
  const templates = new Set(options.templates ?? ["base"]);
  const liveSandboxes = new Set(options.liveSandboxes ?? []);

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
    requests.push({
      method,
      pathname: url.pathname,
      authorization: headers.get("Authorization"),
      body,
    });

    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (method === "GET" && url.pathname === "/v1/health") {
      return json(200, { status: "ok", mock: true, ...(options.health ?? {}) });
    }
    if (method === "GET" && url.pathname === "/v1/templates") {
      return json(200, [...templates].map((id) => ({ id, ready: true })));
    }
    if (method === "GET" && url.pathname === "/v1/sandboxes") {
      return json(200, [...liveSandboxes].map((id) => ({ id })));
    }
    if (method === "POST" && url.pathname === "/v1/fork") {
      const template = String(body?.template ?? "");
      const id = String(body?.id ?? "");
      if (!templates.has(template)) {
        return json(404, { error: `template "${template}" not found` });
      }
      liveSandboxes.add(id);
      return json(200, {
        id,
        template_id: template,
        endpoint: "http://sandbox-node:8080",
        fork_time_ms: 0.8,
        ...(options.forkToken ? { token: options.forkToken } : {}),
      });
    }
    if (method === "DELETE" && url.pathname.startsWith("/v1/sandboxes/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/sandboxes/".length));
      if (!liveSandboxes.has(id)) {
        return json(404, { error: `sandbox "${id}" not found` });
      }
      liveSandboxes.delete(id);
      return json(200, { status: "terminated", id });
    }
    if (method === "POST" && url.pathname === "/v1/files/mkdir") {
      return json(200, { status: "ok" });
    }
    if (method === "POST" && url.pathname === "/v1/files/write") {
      return json(200, { status: "ok" });
    }
    if (method === "POST" && url.pathname === "/v1/exec") {
      return json(200, options.exec ?? { exit_code: 0, stdout: "ok\n", stderr: "" });
    }
    return json(404, { error: `unhandled ${method} ${url.pathname}` });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock, liveSandboxes };
}

const BASE_CONFIG = {
  apiUrl: "http://sandbox-server:8080",
  template: "base",
};

describe("Mitos snapshot-fork sandbox provider plugin", () => {
  beforeEach(() => {
    delete process.env.MITOS_SANDBOX_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("declares environment lifecycle handlers", async () => {
    expect(await plugin.definition.onHealth?.()).toEqual({
      status: "ok",
      message: "Mitos sandbox provider plugin healthy",
    });
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentResumeLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentDestroyLease).toBeTypeOf("function");
  });

  it("validateConfig hits health and confirms the template exists", async () => {
    const { requests } = installMockServer({ templates: ["base"] });

    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "mitos",
      config: { ...BASE_CONFIG, execTimeoutMs: "120000", reuseLease: true },
    });

    expect(result?.ok).toBe(true);
    const paths = requests.map((r) => `${r.method} ${r.pathname}`);
    expect(paths).toContain("GET /v1/health");
    expect(paths).toContain("GET /v1/templates");
    // Normalized config must never carry the resolved token.
    expect(result?.normalizedConfig?.token).toBeUndefined();
  });

  it("rejects config that is missing apiUrl or template before any network call", async () => {
    const { fetchMock } = installMockServer();

    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "mitos",
      config: { apiUrl: "http://sandbox-server:8080" },
    });

    expect(result?.ok).toBe(false);
    expect(result?.errors).toContain("template is required (the template or snapshot id to fork from).");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flags a template that is not registered on the server", async () => {
    installMockServer({ templates: ["other"] });

    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "mitos",
      config: { ...BASE_CONFIG },
    });

    expect(result?.ok).toBe(false);
    expect(result?.errors?.some((e) => e.includes('template "base" is not registered'))).toBe(true);
  });

  it("acquires a lease by forking and stores the per-sandbox token in metadata", async () => {
    const { requests } = installMockServer({ forkToken: "tok-secret-value" });

    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "mitos",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: { ...BASE_CONFIG },
    });

    expect(lease?.providerLeaseId).toMatch(/^mitos-/);
    expect(lease?.metadata).toMatchObject({
      provider: "mitos",
      template: "base",
      endpoint: "http://sandbox-node:8080",
      resumedLease: false,
    });
    // The fork token is captured into lease metadata (an ephemeral capability),
    // and the fork went to the right endpoint with a workspace mkdir.
    expect(typeof lease?.metadata?.token).toBe("string");
    const paths = requests.map((r) => `${r.method} ${r.pathname}`);
    expect(paths).toContain("POST /v1/fork");
    expect(paths).toContain("POST /v1/files/mkdir");
  });

  it("execute sends the bearer token to the sandbox endpoint and maps the result", async () => {
    installMockServer({ exec: { exit_code: 7, stdout: "hello\n", stderr: "warn\n" } });

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "mitos",
      companyId: "company-1",
      environmentId: "env-1",
      config: { ...BASE_CONFIG },
      lease: {
        providerLeaseId: "mitos-abc",
        metadata: {
          provider: "mitos",
          endpoint: "http://sandbox-node:8080",
          token: "tok-secret-value",
          remoteCwd: "/workspace",
        },
      },
      command: "printf",
      args: ["hello"],
      cwd: "/workspace",
      env: { FOO: "bar" },
      timeoutMs: 5000,
    });

    expect(result).toEqual({
      exitCode: 7,
      timedOut: false,
      stdout: "hello\n",
      stderr: "warn\n",
    });

    // Inspect the exec request: it must target the per-sandbox endpoint, carry
    // the bearer token, and reference the sandbox id.
    const fetchMock = vi.mocked(fetch);
    const execCall = fetchMock.mock.calls.find(
      ([url]) => new URL(String(url)).pathname === "/v1/exec",
    );
    expect(execCall).toBeDefined();
    const [execUrl, execInit] = execCall as [string, RequestInit];
    expect(new URL(String(execUrl)).origin).toBe("http://sandbox-node:8080");
    expect(new Headers(execInit.headers).get("Authorization")).toBe("Bearer tok-secret-value");
    const execBody = JSON.parse(String(execInit.body)) as Record<string, unknown>;
    expect(execBody.sandbox).toBe("mitos-abc");
    expect(execBody.command).toContain("'printf' 'hello'");
    expect(execBody.working_dir).toBe("/workspace");
    expect(execBody.env).toEqual({ FOO: "bar" });
  });

  it("rejects invalid shell env keys before execution", async () => {
    installMockServer();

    await expect(
      plugin.definition.onEnvironmentExecute?.({
        driverKey: "mitos",
        companyId: "company-1",
        environmentId: "env-1",
        config: { ...BASE_CONFIG },
        lease: {
          providerLeaseId: "mitos-abc",
          metadata: { endpoint: "http://sandbox-node:8080", remoteCwd: "/workspace" },
        },
        command: "printf",
        args: ["hi"],
        env: { "BAD-KEY": "x" },
      }),
    ).rejects.toThrow("Invalid sandbox environment variable key: BAD-KEY");
  });

  it("returns a timed-out result when the exec transport fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/v1/exec") {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "mitos",
      companyId: "company-1",
      environmentId: "env-1",
      config: { ...BASE_CONFIG },
      lease: {
        providerLeaseId: "mitos-abc",
        metadata: { endpoint: "http://sandbox-node:8080", remoteCwd: "/workspace" },
      },
      command: "sleep",
      args: ["60"],
      timeoutMs: 1000,
    });

    expect(result?.timedOut).toBe(true);
    expect(result?.exitCode).toBeNull();
  });

  it("destroyLease deletes the sandbox", async () => {
    const { requests, liveSandboxes } = installMockServer({ liveSandboxes: ["mitos-xyz"] });

    await plugin.definition.onEnvironmentDestroyLease?.({
      driverKey: "mitos",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "mitos-xyz",
      config: { ...BASE_CONFIG },
    });

    expect(liveSandboxes.has("mitos-xyz")).toBe(false);
    expect(requests.some((r) => r.method === "DELETE" && r.pathname === "/v1/sandboxes/mitos-xyz")).toBe(true);
  });

  it("releaseLease deletes ephemeral leases and keeps reusable ones", async () => {
    const ephemeral = installMockServer({ liveSandboxes: ["mitos-ephemeral"] });
    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "mitos",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "mitos-ephemeral",
      config: { ...BASE_CONFIG, reuseLease: false },
    });
    expect(ephemeral.liveSandboxes.has("mitos-ephemeral")).toBe(false);
    vi.unstubAllGlobals();

    const reusable = installMockServer({ liveSandboxes: ["mitos-reusable"] });
    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "mitos",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "mitos-reusable",
      config: { ...BASE_CONFIG, reuseLease: true },
    });
    // reuseLease keeps the sandbox alive: no DELETE is issued.
    expect(reusable.liveSandboxes.has("mitos-reusable")).toBe(true);
    expect(reusable.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("resumeLease re-forks a fresh sandbox from the snapshot when not reusing", async () => {
    const { requests } = installMockServer();

    const lease = await plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "mitos",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "mitos-old",
      leaseMetadata: { endpoint: "http://sandbox-node:8080", remoteCwd: "/workspace" },
      config: { ...BASE_CONFIG, reuseLease: false },
    });

    expect(lease?.providerLeaseId).toMatch(/^mitos-/);
    expect(lease?.providerLeaseId).not.toBe("mitos-old");
    expect(lease?.metadata).toMatchObject({ provider: "mitos", resumedLease: true });
    expect(requests.some((r) => r.method === "POST" && r.pathname === "/v1/fork")).toBe(true);
  });

  it("resumeLease reuses the existing sandbox in place when reuseLease is set and it is live", async () => {
    const { requests } = installMockServer({ liveSandboxes: ["mitos-live"] });

    const lease = await plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "mitos",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "mitos-live",
      leaseMetadata: { endpoint: "http://sandbox-node:8080", remoteCwd: "/work" },
      config: { ...BASE_CONFIG, reuseLease: true },
    });

    expect(lease?.providerLeaseId).toBe("mitos-live");
    expect(lease?.metadata).toMatchObject({ resumedLease: true, remoteCwd: "/work" });
    // No fork is issued when the prior sandbox is reused in place.
    expect(requests.some((r) => r.pathname === "/v1/fork")).toBe(false);
  });
});
