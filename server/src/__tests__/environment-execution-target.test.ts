import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import {
  DEFAULT_SANDBOX_REMOTE_CWD,
  resolveEnvironmentExecutionTarget,
} from "../services/environment-execution-target.js";

describe("resolveEnvironmentExecutionTarget", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
  });

  it("uses a bounded default cwd for sandbox targets when lease metadata omits remoteCwd", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: DEFAULT_SANDBOX_REMOTE_CWD,
      leaseId: "lease-1",
      environmentId: "env-1",
      timeoutMs: 30_000,
    });
  });

  it("keeps sandbox targets on bridge mode even when lease metadata includes a Paperclip API URL", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        paperclipApiUrl: "https://paperclip.example.test",
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: DEFAULT_SANDBOX_REMOTE_CWD,
    });
    expect(target).not.toHaveProperty("paperclipApiUrl");
    expect(target).not.toHaveProperty("paperclipTransport");
  });

  it("passes through a provider-declared sandbox shell command from lease metadata", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "claude_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        shellCommand: "bash",
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      shellCommand: "bash",
    });
  });

  it("suppresses the buffered onLog dump when the runner reports streamed output, and forwards onOutput", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "fake-plugin", reuseLease: false, timeoutMs: 30_000 },
    });

    const executeSpy = vi.fn(async (input: Record<string, unknown>) => {
      const onOutput = input.onOutput as
        | ((stream: "stdout" | "stderr", text: string) => void)
        | undefined;
      onOutput?.("stdout", "live-chunk");
      return { exitCode: 0, timedOut: false, stdout: "live-chunk", stderr: "", streamed: true };
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "fake-plugin" } },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: { providerLeaseId: "pl-1" } as never,
      environmentRuntime: { execute: executeSpy, supportsSync: () => false } as never,
    });

    expect(target?.kind).toBe("remote");
    const runner = (target as { runner?: { execute: (i: unknown) => Promise<unknown> } }).runner!;
    expect(runner).toBeTruthy();

    const logCalls: Array<[string, string]> = [];
    const outputCalls: Array<[string, string]> = [];
    const result = (await runner.execute({
      command: "echo",
      args: ["hi"],
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logCalls.push([stream, chunk]);
      },
      onOutput: (stream: "stdout" | "stderr", text: string) => {
        outputCalls.push([stream, text]);
      },
    })) as { streamed?: boolean; stdout: string };

    expect(executeSpy.mock.calls[0][0]).toHaveProperty("onOutput");
    expect(outputCalls).toEqual([["stdout", "live-chunk"]]);
    expect(logCalls).toEqual([]);
    expect(result.streamed).toBe(true);
    expect(result.stdout).toBe("live-chunk");
  });

  it("still emits the buffered onLog dump for a legacy (non-streamed) runner result", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "fake-plugin", reuseLease: false, timeoutMs: 30_000 },
    });

    const executeSpy = vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: "buffered-out",
      stderr: "buffered-err",
    }));

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "fake-plugin" } },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: { providerLeaseId: "pl-1" } as never,
      environmentRuntime: { execute: executeSpy, supportsSync: () => false } as never,
    });

    const runner = (target as { runner?: { execute: (i: unknown) => Promise<unknown> } }).runner!;
    const logCalls: Array<[string, string]> = [];
    await runner.execute({
      command: "echo",
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logCalls.push([stream, chunk]);
      },
    });

    expect(logCalls).toEqual([
      ["stdout", "buffered-out"],
      ["stderr", "buffered-err"],
    ]);
  });

  it("keeps sandbox targets on callback bridge execution even when lease metadata advertises SSH access", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "claude_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        remoteCwd: "/home/sandbox/paperclip-workspace",
        sshAccess: {
          type: "ssh",
          host: "ssh.example.test",
          port: 22,
          username: "paperclip",
        },
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: "/home/sandbox/paperclip-workspace",
    });
  });

  it("marks the sandbox target pre-baked only when the lease declares runtimeImagePrebaked", async () => {
    // A lease from a provider plugin that explicitly declares its runtime images
    // are pre-baked (the k8s sandbox plugin) disables the network-install shim
    // and fails fast on a missing CLI.
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "kubernetes", reuseLease: false, timeoutMs: 30_000 },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "gemini_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "kubernetes" } },
      leaseId: "lease-1",
      leaseMetadata: {
        sandboxProviderPlugin: true,
        runtimeImagePrebaked: true,
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      prebakedRuntime: true,
    });
  });

  it("keeps a plugin-backed lease provisionable (install path) when it does NOT declare runtimeImagePrebaked", async () => {
    // A provider plugin that ships a GENERIC sandbox and relies on runtime
    // installation is plugin-backed but must NOT be treated as pre-baked, or its
    // install (Layer 3) is wrongly dropped and a provisionable run turns into a
    // spurious adapter_runtime_image_mismatch.
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "generic-plugin", reuseLease: false, timeoutMs: 30_000 },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "gemini_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "generic-plugin" } },
      leaseId: "lease-1",
      leaseMetadata: {
        sandboxProviderPlugin: true,
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      prebakedRuntime: false,
    });
  });

  it("resolves sandbox targets for every remote-managed adapter, including grok_local", async () => {
    for (const adapterType of [
      "claude_local",
      "codex_local",
      "cursor",
      "gemini_local",
      "grok_local",
      "opencode_local",
      "pi_local",
    ]) {
      mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
          reuseLease: false,
          timeoutMs: 30_000,
        },
      });

      const target = await resolveEnvironmentExecutionTarget({
        db: {} as never,
        companyId: "company-1",
        adapterType,
        environment: {
          id: "env-1",
          driver: "sandbox",
          config: { provider: "fake-plugin" },
        },
        leaseId: "lease-1",
        leaseMetadata: {},
        lease: null,
        environmentRuntime: null,
      });

      expect(target, `adapter ${adapterType}`).toMatchObject({
        kind: "remote",
        transport: "sandbox",
        providerKey: "fake-plugin",
      });
    }
  });

  it("returns null for adapters without remote-managed environment support", async () => {
    for (const driver of ["sandbox", "ssh"] as const) {
      const target = await resolveEnvironmentExecutionTarget({
        db: {} as never,
        companyId: "company-1",
        adapterType: "process",
        environment: {
          id: "env-1",
          driver,
          config: { provider: "fake-plugin" },
        },
        leaseId: "lease-1",
        leaseMetadata: {},
        lease: null,
        environmentRuntime: null,
      });

      expect(target, `driver ${driver}`).toBeNull();
    }
    expect(mockResolveEnvironmentDriverConfigForRuntime).not.toHaveBeenCalled();
  });

  it("resolves SSH execution targets for grok_local", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        privateKey: "PRIVATE KEY",
        knownHosts: "[ssh.example.test]:22 ssh-ed25519 AAAA",
        strictHostKeyChecking: true,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "grok_local",
      environment: {
        id: "env-ssh-1",
        driver: "ssh",
        config: {},
      },
      leaseId: "lease-ssh-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/srv/paperclip",
    });
  });

  it("resolves SSH execution targets in bridge mode", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        privateKey: "PRIVATE KEY",
        knownHosts: "[ssh.example.test]:22 ssh-ed25519 AAAA",
        strictHostKeyChecking: true,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-ssh-1",
        driver: "ssh",
        config: {},
      },
      leaseId: "lease-ssh-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/srv/paperclip",
      leaseId: "lease-ssh-1",
      environmentId: "env-ssh-1",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        remoteCwd: "/srv/paperclip",
      },
    });
    expect(target).not.toHaveProperty("paperclipApiUrl");
  });

  it("exposes a sandbox runner that counts round-trips and accumulates provider durations", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    // Each exec reports its provider-boundary durations on the free-form result
    // metadata (the Daytona plugin does this); the runner accumulates them.
    const environmentRuntime = {
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        metadata: { durationMs: 600, getDurationMs: 15 },
      }),
      supportsSync: vi.fn().mockReturnValue(false),
    };

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "fake-plugin" } },
      leaseId: "lease-1",
      leaseMetadata: { remoteCwd: "/workspace" },
      lease: { id: "lease-1" } as never,
      environmentRuntime: environmentRuntime as never,
    });

    const runner = (target as { runner?: {
      supportsSingleStreamStdinProgress?: boolean;
      execCount(): number;
      providerExecMs(): number;
      providerGetMs(): number;
      execute(input: { command: string; args?: string[] }): Promise<unknown>;
    } }).runner;
    expect(runner).toBeTruthy();
    // Single-stream stdin upload is enabled (research A1 / PAP-3159 #2): a
    // ≤96 MiB writeFile collapses to one round-trip.
    expect(runner!.supportsSingleStreamStdinProgress).toBe(false);
    expect(runner!.execCount()).toBe(0);
    expect(runner!.providerExecMs()).toBe(0);
    expect(runner!.providerGetMs()).toBe(0);

    await runner!.execute({ command: "echo", args: ["a"] });
    await runner!.execute({ command: "echo", args: ["b"] });

    expect(runner!.execCount()).toBe(2);
    expect(runner!.providerExecMs()).toBe(1200);
    expect(runner!.providerGetMs()).toBe(30);
  });

  it("tolerates a provider result with no timing metadata (counts the round-trip, accumulates nothing)", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "fake-plugin", reuseLease: false, timeoutMs: 30_000 },
    });

    const environmentRuntime = {
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
      }),
      supportsSync: vi.fn().mockReturnValue(false),
    };

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "fake-plugin" } },
      leaseId: "lease-1",
      leaseMetadata: { remoteCwd: "/workspace" },
      lease: { id: "lease-1" } as never,
      environmentRuntime: environmentRuntime as never,
    });

    const runner = (target as { runner?: {
      execCount(): number;
      providerExecMs(): number;
      providerGetMs(): number;
      execute(input: { command: string }): Promise<unknown>;
    } }).runner;
    await runner!.execute({ command: "echo" });

    expect(runner!.execCount()).toBe(1);
    expect(runner!.providerExecMs()).toBe(0);
    expect(runner!.providerGetMs()).toBe(0);
  });
});
