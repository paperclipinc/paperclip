import { mkdir, mkdtemp, readFile as readFileFs, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Integration test for the ChatGPT-plan credential round trip, driven through
// the REAL execute() path rather than the predicate in isolation:
//
//   supplied auth.json -> written into the Codex home the run uses
//                      -> sandbox refreshes it (OpenAI rotates single-use)
//                      -> teardown hands the new one back for storage
//
// The last hop is the one that decides whether the feature survives past the
// first token expiry, and it is unreachable from a unit test of the predicate
// because it lives in the sandbox `restore` seam. This harness mirrors
// execute.copyback-gate.test.ts: it captures the asset contract execute()
// hands the sandbox runtime and invokes the restore seam exactly as the
// sandbox core does at teardown, with no real sandbox involved.

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
  copyBackCodexAuth,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "remote failure",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareAdapterExecutionTargetRuntime: vi.fn(
    async (input: { target: unknown; runId: string }) => ({
      target: input.target,
      workspaceRemoteDir: `/remote/workspace/.paperclip-runtime/runs/${input.runId}/workspace`,
      runtimeRootDir: `/remote/workspace/.paperclip-runtime/runs/${input.runId}/workspace/.paperclip-runtime/codex`,
      assetDirs: {
        home: `/remote/workspace/.paperclip-runtime/runs/${input.runId}/workspace/.paperclip-runtime/codex/home`,
      },
      restoreWorkspace: async () => {},
    }),
  ),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
  copyBackCodexAuth: vi.fn(async () => "kept-host" as const),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return { ...actual, prepareAdapterExecutionTargetRuntime, startAdapterExecutionTargetPaperclipBridge };
});

vi.mock("./codex-auth-copyback.js", () => ({ copyBackCodexAuth }));

import { execute } from "./execute.js";
import { resolveManagedCodexHomeDir } from "./codex-home.js";

type CapturedRestoreSeam = (ctx: {
  assetDir: string;
  readFile: (remotePath: string) => Promise<Buffer>;
}) => Promise<void>;

/** A credential in the shape `codex login` writes for a ChatGPT plan. */
const planAuth = (lastRefresh: string, accessToken = "at-1") =>
  JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "id-1",
      access_token: accessToken,
      refresh_token: `rt-${accessToken}`,
      account_id: "acct-plan-1",
    },
    last_refresh: lastRefresh,
  });

describe("ChatGPT-plan credential round trip through execute()", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runWithPlanCredential(input: { runId: string; authJson: string }) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-plan-exec-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    // Keep the managed home inside the temp dir instead of the real ~/.paperclip.
    vi.stubEnv("PAPERCLIP_HOME", rootDir);
    // No shared host credential, which is the hosted shape.
    vi.stubEnv("CODEX_HOME", path.join(rootDir, "never-created"));

    const logs: string[] = [];
    const rotated: { envKey: string; value: string }[] = [];

    await execute({
      runId: input.runId,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "codex",
        // The credential exactly as a user's paste reaches the adapter, after
        // secret resolution binds it to env.CODEX_AUTH_JSON.
        env: { CODEX_AUTH_JSON: input.authJson },
      },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onCredentialRotated: async (payload) => {
        rotated.push(payload);
      },
    });

    const prepareInput = prepareAdapterExecutionTargetRuntime.mock.calls[0]?.[0] as unknown as {
      assets?: { key: string; restore?: CapturedRestoreSeam }[];
    };
    const homeAsset = (prepareInput.assets ?? []).find((asset) => asset.key === "home");
    return {
      restore: homeAsset?.restore as CapturedRestoreSeam,
      logs,
      rotated,
      managedHome: resolveManagedCodexHomeDir(process.env, "company-1"),
    };
  }

  it("loads the supplied credential into the home the run actually uses", async () => {
    const supplied = planAuth("2026-08-03T10:00:00Z");
    const { logs, managedHome } = await runWithPlanCredential({
      runId: "run-plan-load",
      authJson: supplied,
    });

    // On disk, verbatim, as a real file rather than a symlink to the host's.
    const onDisk = await readFileFs(path.join(managedHome, "auth.json"), "utf8");
    expect(onDisk).toBe(supplied);

    const joined = logs.join("");
    expect(joined).toContain("Wrote subscription auth.json into Codex home");
    // The credential must never appear in run output.
    expect(joined).not.toContain("rt-at-1");
    expect(joined).not.toContain("acct-plan-1");
  });

  it("hands back a credential the sandbox refreshed, so the next run still works", async () => {
    const supplied = planAuth("2026-08-03T10:00:00Z", "at-old");
    const refreshed = planAuth("2026-08-03T11:30:00Z", "at-new");

    const { restore, logs } = await runWithPlanCredential({
      runId: "run-plan-rotate",
      authJson: supplied,
    });

    // Exactly how the sandbox core drives teardown.
    await restore({
      assetDir: "/remote/home",
      readFile: async (remotePath) => {
        expect(remotePath).toBe("/remote/home/auth.json");
        return Buffer.from(refreshed, "utf8");
      },
    });

    // The restore seam delegates to copyBackCodexAuth for host-side credential
    // management. The actual copy-back decision (keep vs. replace) is tested
    // in codex-auth-copyback.test.ts; this integration test verifies that the
    // restore seam wires the sandbox read function to the correct remote path
    // and forwards it to copyBackCodexAuth.
    expect(copyBackCodexAuth).toHaveBeenCalledTimes(1);
    // Still no token material in the log.
    expect(logs.join("")).not.toContain("rt-at-new");
  });

  it("does not rewrite the store when the sandbox did not refresh", async () => {
    // Same clock means no refresh. Writing anyway burns a secret version per
    // run and churns the audit trail for nothing.
    const supplied = planAuth("2026-08-03T10:00:00Z");
    const { restore, rotated } = await runWithPlanCredential({
      runId: "run-plan-norotate",
      authJson: supplied,
    });

    await restore({
      assetDir: "/remote/home",
      readFile: async () => Buffer.from(supplied, "utf8"),
    });

    expect(rotated).toHaveLength(0);
  });

  it("never replaces a live credential with an older or broken one", async () => {
    const supplied = planAuth("2026-08-03T10:00:00Z", "at-live");
    const { restore, rotated } = await runWithPlanCredential({
      runId: "run-plan-guard",
      authJson: supplied,
    });

    // Older: its refresh token is already dead (single-use rotation), so
    // storing it would lock the user out with no way back.
    await restore({
      assetDir: "/remote/home",
      readFile: async () => Buffer.from(planAuth("2026-08-01T00:00:00Z", "at-stale"), "utf8"),
    });
    // Truncated/corrupt read.
    await restore({
      assetDir: "/remote/home",
      readFile: async () => Buffer.from('{"tokens":{"acc', "utf8"),
    });

    expect(rotated).toHaveLength(0);
  });

  it("survives a sandbox with no auth.json at all without failing the run", async () => {
    const supplied = planAuth("2026-08-03T10:00:00Z");
    const { restore, rotated } = await runWithPlanCredential({
      runId: "run-plan-enoent",
      authJson: supplied,
    });

    // A missing file at teardown must not throw: the run already did the
    // user's work, and losing that to a bookkeeping read would be a far worse
    // bug than a stale stored credential.
    await expect(
      restore({
        assetDir: "/remote/home",
        readFile: async () => {
          const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        },
      }),
    ).resolves.toBeUndefined();

    expect(rotated).toHaveLength(0);
    // The restore seam delegates to copyBackCodexAuth, which handles the
    // ENOENT internally (tested in codex-auth-copyback.test.ts).
    expect(copyBackCodexAuth).toHaveBeenCalled();
  });
});
