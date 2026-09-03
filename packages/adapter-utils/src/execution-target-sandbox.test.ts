import { createServer } from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { duplexPair, type Duplex } from "node:stream";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSandboxDuplexGatewayCodecSource } from "./sandbox-callback-bridge.js";

import {
  __duplexReadinessTesting,
  __http2PrefaceScanTesting,
  DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
  AdapterRuntimeImageMismatchError,
  AdapterSandboxProbeUnansweredError,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetToRemoteSpec,
  adapterExecutionTargetUsesPaperclipBridge,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  formatAdapterExecutionTimeoutErrorMessage,
  formatAdapterExecutionTimeoutStartLogLine,
  isAdapterRuntimeImageMismatchError,
  isAdapterSandboxProbeUnansweredError,
  resolveAdapterExecutionTargetTimeout,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetProcessSessionBridge,
  startAdapterExecutionTargetPaperclipBridge,
  type AdapterSandboxExecutionTarget,
  type EffectiveExecutionCapabilities,
  type EffectiveSandboxCapabilities,
} from "./execution-target.js";
import {
  createRuntimeSpanRunner,
  getActiveStepContext,
  type StartupSpan,
  type StartupTraceContext,
  type StartupTracer,
} from "./acpx-engine/startup-timing.js";
import { createSandboxRunLogTailFactory, type SandboxRunLogTailFactory } from "./sandbox-run-log-stream.js";
import { runChildProcess } from "./server-utils.js";
import { shellQuote } from "./ssh.js";
import type { CommandManagedDuplexChannel } from "./command-managed-runtime.js";
import {
  DEFAULT_MAX_DUPLEX_FRAME_BYTES,
  DUPLEX_FRAME_VERSION,
  decodeDuplexLine,
  encodeDuplexFrame,
} from "./duplex-frame-codec.js";
import { DUPLEX_CHANNEL_LOST_ERROR_CODE } from "./bridge-transport-contract.js";
import {
  DUPLEX_COUNTER_CHANNEL_OPEN_TOTAL,
  DUPLEX_COUNTER_FALLBACK_TOTAL,
  DUPLEX_COUNTER_LOSS_TOTAL,
  DUPLEX_DIMENSION_KEYS,
  DUPLEX_SPAN_CHANNEL_OPEN,
  DUPLEX_SPAN_REQUEST,
  DUPLEX_TRANSPORT_EVENT,
  type DuplexLossReason,
  type DuplexObservabilityCounterRecord,
  type DuplexObservabilityDimensions,
  type DuplexObservabilityEventRecord,
  type DuplexObservabilityRecorder,
  type DuplexObservabilitySpanRecord,
} from "./duplex-observability.js";

const execFileAsync = promisify(execFile);

type RecordedSpan = { name: string; parentName: string | null; ended: boolean };

/**
 * A structural tracer that records each opened span's name, parent, and end
 * state, so a test can assert the trace shape a runtime span runner produces.
 * Mirrors the recorder used for the `pack`/`stage.sync` nesting tests.
 */
function createRecordingTraceContext(): {
  traceContext: StartupTraceContext;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];
  const byHandle = new WeakMap<StartupSpan, RecordedSpan>();
  const tracer: StartupTracer = {
    startSpan(name, _options, context) {
      const parent = context as RecordedSpan | undefined;
      const record: RecordedSpan = { name, parentName: parent?.name ?? null, ended: false };
      spans.push(record);
      const handle: StartupSpan = {
        setAttribute() {},
        setStatus() {},
        end() {
          record.ended = true;
        },
      };
      byHandle.set(handle, record);
      return handle;
    },
  };
  const traceContext: StartupTraceContext = {
    tracer,
    contextWithSpan: (span) => byHandle.get(span),
  };
  return { traceContext, spans };
}

describe("sandbox adapter execution targets", () => {
  const cleanupDirs: string[] = [];

  it("records successful issue comment ids for attribution recovery", () => {
    expect(postedIssueCommentLogMarker("POST", "/api/issues/issue-1/comments", 201, '{"id":"comment-1"}'))
      .toBe("comment id: comment-1\n");
    expect(postedIssueCommentLogMarker("POST", "/api/issues/issue-1/comments", 401, '{"id":"comment-1"}'))
      .toBeNull();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createLocalSandboxRunner() {
    let counter = 0;
    return {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
        onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
      }) => {
        counter += 1;
        const command = input.command === "bash" ? "/bin/bash" : input.command;
        return runChildProcess(`sandbox-run-${counter}`, command, input.args ?? [], {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
          onSpawn: input.onSpawn
            ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
            : undefined,
        });
      },
    };
  }

  // Simulates transient sandbox shell failures for the process-session
  // bridge's event polling: reading/removing a specific event file, or
  // listing the events directory itself, can be made to fail on demand
  // while every other shell call passes through to the real local runner.
  function createProcessSessionEventFaultInjectingRunner(input: {
    base: ReturnType<typeof createLocalSandboxRunner>;
    failRead?: (fileName: string, attempt: number) => boolean;
    failRemove?: (fileName: string, attempt: number) => boolean;
    failList?: (attempt: number) => boolean;
  }) {
    const readAttempts = new Map<string, number>();
    const removeAttempts = new Map<string, number>();
    let listAttempts = 0;
    const failResult = (message: string) => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: message,
      pid: null,
      startedAt: new Date().toISOString(),
    });
    return {
      execute: async (execInput: Parameters<ReturnType<typeof createLocalSandboxRunner>["execute"]>[0]) => {
        const script = (execInput.args?.[1] ?? "").trim();
        const readMatch = /^base64 < '([^']*\/events\/[^']+\.json)'$/.exec(script);
        if (readMatch) {
          const fileName = path.posix.basename(readMatch[1]);
          const attempt = (readAttempts.get(fileName) ?? 0) + 1;
          readAttempts.set(fileName, attempt);
          if (input.failRead?.(fileName, attempt)) {
            return failResult(`simulated transient read failure for ${fileName}`);
          }
        }
        const removeMatch = /^rm -rf '([^']*\/events\/[^']+\.json)'$/.exec(script);
        if (removeMatch) {
          const fileName = path.posix.basename(removeMatch[1]);
          const attempt = (removeAttempts.get(fileName) ?? 0) + 1;
          removeAttempts.set(fileName, attempt);
          if (input.failRemove?.(fileName, attempt)) {
            return failResult(`simulated remove failure for ${fileName}`);
          }
        }
        if (/for file in '[^']*\/events'\/\*\.json;/.test(script)) {
          listAttempts += 1;
          if (input.failList?.(listAttempts)) {
            return failResult("simulated event listing failure");
          }
        }
        return input.base.execute(execInput);
      },
    };
  }

  async function readRuntimeTextFiles(rootDir: string): Promise<string[]> {
    const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
    const contents: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        contents.push(...await readRuntimeTextFiles(entryPath));
      } else if (entry.isFile()) {
        contents.push(await readFile(entryPath, "utf8").catch(() => ""));
      }
    }
    return contents;
  }

  function encodeTailTick(stdout: Buffer, stderr: Buffer): string {
    return [
      "__PAPERCLIP_RUN_LOG_STDOUT__",
      stdout.toString("base64"),
      "__PAPERCLIP_RUN_LOG_STDERR__",
      stderr.toString("base64"),
      "__PAPERCLIP_RUN_LOG_END__",
      "",
    ].join("\n");
  }

  async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(message);
  }

  type ProxyRunResult = {
    stdout: string;
    stderr: string;
    code: number | null;
    /**
     * How long the exchange took. The bridge and the proxy both run on 5s
     * budgets, which is generous locally and tight on a CI runner sharing a
     * box with 19 other lanes. A run that returns fast and empty is a
     * different fault from one that nearly hit the ceiling, and the numbers
     * are the only way to tell them apart after the fact.
     */
    elapsedMs: number;
  };

  async function runProxyWithInput(command: string, input: string): Promise<ProxyRunResult> {
    const startedAt = performance.now();
    const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(input);
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Timed out waiting for process session proxy."));
      }, 5000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });
    return { stdout, stderr, code, elapsedMs: Math.round(performance.now() - startedAt) };
  }

  /**
   * A failure report for a proxy exchange, attached to the assertions below.
   *
   * `execution-target-sandbox` has failed twice in CI and never once in a few
   * hundred local runs, so the next occurrence has to carry its own evidence -
   * a second unreproducible failure teaches nothing. The observed signature was
   * an empty stdout with exit code 0, meaning the child exited cleanly having
   * produced nothing, which is what a lost stdin frame looks like from here.
   *
   * The runtime tree is the part that discriminates. The stdin queue files are
   * written by the host and deleted by the wrapper once parsed, so what remains
   * says whether the frame was never written, written and never consumed, or
   * consumed normally and the reply lost on the way back.
   */
  async function describeProxyRun(result: ProxyRunResult, runtimeRootDir: string): Promise<string> {
    const lines = [
      `proxy exit=${result.code} elapsedMs=${result.elapsedMs}`,
      `proxy stdout=${JSON.stringify(result.stdout)}`,
      `proxy stderr=${JSON.stringify(result.stderr)}`,
    ];
    const walk = async (dir: string, depth: number): Promise<void> => {
      // Deep enough to reach the queue frames, which are the point. They sit
      // at process-sessions/<id>/stdin/<seq>.json — depth 4 from the runtime
      // root — so a cap of 3 listed the `stdin/` directory and stopped, making
      // "the queue is empty" and "the walk never looked" print identically.
      if (depth > 5) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        lines.push(`${"  ".repeat(depth)}<unreadable ${dir}: ${(error as Error).message}>`);
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          lines.push(`${"  ".repeat(depth)}${entry.name}/`);
          await walk(full, depth + 1);
          continue;
        }
        // Small files are the queue and event frames, and their contents are
        // the point. Anything larger is a child script or a log; the size is
        // enough to say it exists.
        let detail = "";
        try {
          const raw = await readFile(full, "utf8");
          detail = raw.length <= 400 ? ` ${JSON.stringify(raw)}` : ` <${raw.length}B>`;
        } catch (error) {
          detail = ` <unreadable: ${(error as Error).message}>`;
        }
        lines.push(`${"  ".repeat(depth)}${entry.name}${detail}`);
      }
    };
    lines.push(`runtime tree under ${runtimeRootDir}:`);
    await walk(runtimeRootDir, 1);
    return lines.join("\n");
  }

  function combinedStream(
    events: Array<{ stream: "stdout" | "stderr"; chunk: string }>,
    stream: "stdout" | "stderr",
  ): string {
    return events.filter((event) => event.stream === stream).map((event) => event.chunk).join("");
  }

  it("executes through the provider-neutral runner without a remote spec", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "acme-sandbox",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/workspace",
      timeoutMs: 30_000,
      runner,
    };

    expect(adapterExecutionTargetToRemoteSpec(target)).toBeNull();

    const result = await runAdapterExecutionTargetProcess("run-1", target, "agent-cli", ["--json"], {
      cwd: "/local/workspace",
      env: { TOKEN: "token" },
      stdin: "prompt",
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
    });

    expect(result.stdout).toBe("ok\n");
    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "agent-cli",
      args: ["--json"],
      cwd: "/workspace",
      env: { TOKEN: "token" },
      stdin: "prompt",
      timeoutMs: 5000,
    }));
    expect(adapterExecutionTargetSessionIdentity(target)).toEqual({
      transport: "sandbox",
      providerKey: "acme-sandbox",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/workspace",
    });
  });

  it("preserves stdin when wrapping sandbox adapter commands for run-log streaming", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-stdin-"));
    cleanupDirs.push(rootDir);
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      streamRunLogs: true,
      runner: createLocalSandboxRunner(),
    };
    const logsDir = path.posix.join(rootDir, ".paperclip-runtime", "bridge", "logs");
    const runLogTail = createSandboxRunLogTailFactory({
      runner: target.runner!,
      remoteCwd: rootDir,
      logsDir,
      shellCommand: "bash",
    }).create();
    const events: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    const result = await runAdapterExecutionTargetProcess(
      "run-log-stdin",
      target,
      process.execPath,
      ["-e", "process.stdin.setEncoding('utf8'); let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => process.stdout.write('stdin=' + s));"],
      {
        cwd: rootDir,
        env: {},
        stdin: "hello-through-wrapper",
        timeoutSec: 5,
        graceSec: 1,
        runLogTail: { create: () => runLogTail },
        onLog: async (stream, chunk) => { events.push({ stream, chunk }); },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("stdin=hello-through-wrapper");
    expect(combinedStream(events, "stdout")).toContain("stdin=hello-through-wrapper");
  });

  it("creates the process session directories only in the launch exec, not in upfront makeDir execs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-makedir-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    const delegate = createLocalSandboxRunner();
    const execScripts: string[] = [];
    const runner = {
      execute: vi.fn(async (input: Parameters<typeof delegate.execute>[0]) => {
        execScripts.push(input.args?.[1] ?? "");
        return delegate.execute(input);
      }),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-makedir",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    try {
      // No standalone `mkdir -p '<dir>/stdin'` or `.../events` exec runs before launch.
      const standaloneSessionDirExecs = execScripts.filter((script) =>
        /^mkdir -p '[^']*\/(stdin|events)'\s*$/.test(script),
      );
      expect(standaloneSessionDirExecs).toEqual([]);

      // The launch exec creates both directories in one `mkdir -p` line.
      const launchExecs = execScripts.filter(
        (script) => script.includes("nohup") && /mkdir -p [^\n]*\/stdin[^\n]*\/events/.test(script),
      );
      expect(launchExecs.length).toBe(1);
    } finally {
      await bridge?.stop();
    }
  });

  it.each([
    { outputMode: "polled", streamOutputViaSession: false },
    { outputMode: "streamed", streamOutputViaSession: true },
  ])(
    "preserves an explicit remote PATH equal to host PATH in $outputMode mode",
    async ({ outputMode, streamOutputViaSession }) => {
      const rootDir = await mkdtemp(
        path.join(os.tmpdir(), `paperclip-process-session-${outputMode}-path-`),
      );
      cleanupDirs.push(rootDir);
      const childPath = path.join(rootDir, "print-path-child.mjs");
      await writeFile(
        childPath,
        'process.stdout.write(process.env.PATH ?? "<missing>");\n',
        "utf8",
      );

      const nodeBinDir = path.dirname(process.execPath);
      const explicitHostPath = `${nodeBinDir}:/explicit-host-bin`;
      const sandboxNativePath = `/usr/bin:/bin:${nodeBinDir}`;
      vi.stubEnv("PATH", explicitHostPath);

      const delegate = createLocalSandboxRunner();
      const runner = {
        execute: vi.fn(
          async (input: Parameters<typeof delegate.execute>[0]) =>
            delegate.execute({
              ...input,
              // The local fake otherwise inherits the test host PATH. Give the
              // wrapper a distinct sandbox-native PATH so the child proves the
              // explicit equal-to-host value survived payload serialization.
              env: { ...input.env, PATH: sandboxNativePath },
            }),
        ),
      };
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "local-test",
        remoteCwd: rootDir,
        timeoutMs: 30_000,
        runner,
      };

      const bridge = await startAdapterExecutionTargetProcessSessionBridge({
        runId: `run-process-session-${outputMode}-path`,
        target,
        runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
        adapterKey: "acpx",
        command: process.execPath,
        args: [childPath],
        cwd: rootDir,
        env: { PATH: explicitHostPath },
        timeoutSec: 5,
        onLog: async () => {},
        streamOutputViaSession,
      });
      expect(bridge).not.toBeNull();

      try {
        const result = await runProxyWithInput(bridge!.agentCommand, "");
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(explicitHostPath);
      } finally {
        await bridge?.stop();
      }
    },
  );

  it("test_process_session_poll_exec_parents_to_run_context", async () => {
    // The poll timer runs run-time execs for the whole run. Its `sandbox.exec`
    // span must parent to the live run span, not to the ended startup step. The
    // bridge reads `getRuntimeParentContext` per tick and runs the poll under
    // that token. This test drives the bridge with a getter that returns a known
    // token, lets the first poll tick fire, and proves the poll exec reads that
    // token from the active step store.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-poll-parent-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    const runParentToken = { marker: "process-session-run-parent" };
    let bridgeStarted = false;
    let pollStep: ReturnType<typeof getActiveStepContext> | "unset" = "unset";
    let resolvePoll: () => void = () => {};
    const pollObserved = new Promise<void>((resolve) => {
      resolvePoll = resolve;
    });

    const delegate = createLocalSandboxRunner();
    const runner = {
      execute: async (input: Parameters<typeof delegate.execute>[0]) => {
        // Record the active step for the first exec that runs after the bridge
        // start resolves. The setup execs run during the measured start; the
        // poll timer fires later, under the run parent context.
        if (bridgeStarted && pollStep === "unset") {
          pollStep = getActiveStepContext();
          resolvePoll();
        }
        return delegate.execute(input);
      },
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-poll-parent",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
      getRuntimeParentContext: () => runParentToken,
    });
    expect(bridge).not.toBeNull();
    bridgeStarted = true;

    try {
      await pollObserved;
      // The poll exec ran under the run parent context, so its exec span parents
      // to the run token, not to a detached root or an ended startup step.
      expect(pollStep).not.toBe("unset");
      expect(pollStep).not.toBeNull();
      expect((pollStep as { parentContext?: unknown }).parentContext).toBe(runParentToken);
      expect((pollStep as { criticalPath?: boolean }).criticalPath).toBe(false);
    } finally {
      await bridge?.stop();
    }
  });

  it("test_process_session_poll_exec_stays_unparented_without_getter", async () => {
    // With no `getRuntimeParentContext`, the poll tick runs with an empty active
    // step store, exactly like the earlier `runWithoutActiveStep` behavior. So a
    // poll `sandbox.exec` span opens unparented with no stale startup flag.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-poll-nogetter-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    let bridgeStarted = false;
    let pollStep: ReturnType<typeof getActiveStepContext> | "unset" = "unset";
    let resolvePoll: () => void = () => {};
    const pollObserved = new Promise<void>((resolve) => {
      resolvePoll = resolve;
    });

    const delegate = createLocalSandboxRunner();
    const runner = {
      execute: async (input: Parameters<typeof delegate.execute>[0]) => {
        if (bridgeStarted && pollStep === "unset") {
          pollStep = getActiveStepContext();
          resolvePoll();
        }
        return delegate.execute(input);
      },
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-poll-nogetter",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();
    bridgeStarted = true;

    try {
      await pollObserved;
      expect(pollStep).toBeNull();
    } finally {
      await bridge?.stop();
    }
  });

  it("test_process_session_stdin_exec_reads_send_time_run_parent", async () => {
    // A persistent socket can open under one run parent and receive stdin later,
    // under a different parent. The stdin-write `sandbox.exec` span must parent
    // to the parent that is live at send time, not to the parent that was live
    // when the socket opened. The bridge reads `getRuntimeParentContext` per
    // message in the `data` handler, not once at connect time. This test opens a
    // socket while `connectParent` is live, switches the getter to `turnParent`,
    // sends one stdin line, and proves the stdin write ran under `turnParent`.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stdin-parent-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    const connectParent = { marker: "process-session-connect-parent" };
    const turnParent = { marker: "process-session-turn-parent" };
    let currentParent: unknown = connectParent;

    let stdinWriteStep: ReturnType<typeof getActiveStepContext> | "unset" = "unset";
    let resolveStdinWrite: () => void = () => {};
    const stdinWriteObserved = new Promise<void>((resolve) => {
      resolveStdinWrite = resolve;
    });

    const delegate = createLocalSandboxRunner();
    const runner = {
      execute: async (input: Parameters<typeof delegate.execute>[0]) => {
        // Record the active step for the first exec that writes the stdin file.
        // The `.paperclip-upload` temp path under the `stdin` directory is unique
        // to the stdin-write path; the poll loop reads the `events` directory.
        const script = (input.args ?? []).join("\n");
        if (stdinWriteStep === "unset" && /\/stdin\/[^\s']*paperclip-upload/.test(script)) {
          stdinWriteStep = getActiveStepContext();
          resolveStdinWrite();
        }
        return delegate.execute(input);
      },
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-stdin-parent",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
      getRuntimeParentContext: () => currentParent as never,
    });
    expect(bridge).not.toBeNull();

    let peer: net.Socket | null = null;
    try {
      const proxySource = await readFile(bridge!.agentCommand, "utf8");
      const port = Number(/port: (\d+)/.exec(proxySource)?.[1] ?? Number.NaN);
      const tokenLiteral = /const token = (".*?");/.exec(proxySource)?.[1];
      expect(Number.isFinite(port)).toBe(true);
      expect(typeof tokenLiteral).toBe("string");
      const token = JSON.parse(tokenLiteral as string) as string;

      // Open the socket while `connectParent` is the live run parent.
      const peerSocket = net.createConnection({ host: "127.0.0.1", port });
      peer = peerSocket;
      peerSocket.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        peerSocket.once("connect", () => resolve());
        peerSocket.once("error", reject);
      });
      // Let the server accept the connection and register the `data` handler
      // under the connect-time parent before the getter switches.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // The run enters an agent turn: the live run parent switches.
      currentParent = turnParent;

      // Send one stdin line. The first token-bearing message authenticates and
      // writes the stdin file. That write must read `turnParent` at send time.
      peerSocket.write(`${JSON.stringify({ token, type: "stdin", data: Buffer.from("hi").toString("base64") })}\n`);

      await stdinWriteObserved;
      // The stdin write ran under the send-time parent, not the connect-time
      // parent captured when the socket opened.
      expect(stdinWriteStep).not.toBe("unset");
      expect(stdinWriteStep).not.toBeNull();
      expect((stdinWriteStep as { parentContext?: unknown }).parentContext).toBe(turnParent);
      expect((stdinWriteStep as { parentContext?: unknown }).parentContext).not.toBe(connectParent);
      expect((stdinWriteStep as { criticalPath?: boolean }).criticalPath).toBe(false);
    } finally {
      peer?.destroy();
      await bridge?.stop();
    }
  });

  it("wraps a stdin write in a sandbox.agentSession.sendInput span", async () => {
    // With a span runner injected, the socket handler wraps one outbound ACP
    // message to the agent in a `sandbox.agentSession.sendInput` span. This test
    // connects a socket, sends one stdin line, and proves the handler opens that
    // wrapper span around the write.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-sendinput-span-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    const spanNames: string[] = [];
    let resolveSendInput: () => void = () => {};
    const sendInputObserved = new Promise<void>((resolve) => {
      resolveSendInput = resolve;
    });

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-sendinput-span",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
      // Record each wrapper span name, then run the wrapped work.
      runtimeSpan: async (name, work) => {
        spanNames.push(name);
        if (name === "sandbox.agentSession.sendInput") resolveSendInput();
        return work();
      },
    });
    expect(bridge).not.toBeNull();

    let peer: net.Socket | null = null;
    try {
      const proxySource = await readFile(bridge!.agentCommand, "utf8");
      const port = Number(/port: (\d+)/.exec(proxySource)?.[1] ?? Number.NaN);
      const tokenLiteral = /const token = (".*?");/.exec(proxySource)?.[1];
      const token = JSON.parse(tokenLiteral as string) as string;

      const peerSocket = net.createConnection({ host: "127.0.0.1", port });
      peer = peerSocket;
      peerSocket.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        peerSocket.once("connect", () => resolve());
        peerSocket.once("error", reject);
      });

      // The first token-bearing message authenticates and writes the stdin file.
      peerSocket.write(
        `${JSON.stringify({ token, type: "stdin", data: Buffer.from("hi").toString("base64") })}\n`,
      );

      await sendInputObserved;
      expect(spanNames).toContain("sandbox.agentSession.sendInput");
    } finally {
      peer?.destroy();
      await bridge?.stop();
    }
  });

  it("wraps each poll tick in a sandbox.agentSession.pollOutput span", async () => {
    // With a span runner injected, the poll timer wraps each 100 ms poll tick in
    // a `sandbox.agentSession.pollOutput` span. This test lets the first poll tick
    // fire and proves the timer opens that wrapper span.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-poll-span-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "noop-acp-child.mjs");
    await writeFile(childPath, "process.stdin.on('data', () => {});\n", "utf8");

    const spanNames: string[] = [];
    let resolvePoll: () => void = () => {};
    const pollObserved = new Promise<void>((resolve) => {
      resolvePoll = resolve;
    });

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-poll-span",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
      // Record each wrapper span name, then run the wrapped work.
      runtimeSpan: async (name, work) => {
        spanNames.push(name);
        if (name === "sandbox.agentSession.pollOutput") resolvePoll();
        return work();
      },
    });
    expect(bridge).not.toBeNull();

    try {
      await pollObserved;
      expect(spanNames).toContain("sandbox.agentSession.pollOutput");
    } finally {
      await bridge?.stop();
    }
  });

  it("bridges bidirectional sandbox process sessions through a local ACPX-spawnable proxy", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "fake-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('out:' + chunk.toString());",
        "  process.stderr.write('err:' + chunk.toString());",
        "});",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    try {
      const result = await runProxyWithInput(bridge!.agentCommand, "hello\n");
      const report = await describeProxyRun(result, path.posix.join(rootDir, ".paperclip-runtime", "acpx"));
      expect(result.code, report).toBe(0);
      expect(result.stdout, report).toBe("out:hello\n");
      expect(result.stderr, report).toBe("err:hello\n");
    } finally {
      await bridge?.stop();
    }
  });

  it("buffers sandbox process session output until the local proxy connects", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-buffer-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "fast-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdout.write('early-out\\n');",
        "process.stderr.write('early-err\\n');",
        "setTimeout(() => process.exit(0), 20);",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-buffer",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("early-out\n");
      expect(result.stderr).toBe("early-err\n");
    } finally {
      await bridge?.stop();
    }
  });

  it("delivers full output when the sandbox child exits immediately after writing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-fast-exit-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "instant-exit-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdout.write('final-out\\n');",
        "process.stderr.write('final-err\\n');",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-fast-exit",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    try {
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("final-out\n");
      expect(result.stderr).toBe("final-err\n");
    } finally {
      await bridge?.stop();
    }
  });

  it("ignores unauthenticated connections to the process session bridge", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-auth-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "guarded-acp-child.mjs");
    await writeFile(childPath, "process.stdout.write('guarded-out\\n');", "utf8");
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-auth",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    let squatter: net.Socket | null = null;
    try {
      const proxySource = await readFile(bridge!.agentCommand, "utf8");
      const port = Number(/port: (\d+)/.exec(proxySource)?.[1] ?? Number.NaN);
      expect(Number.isFinite(port)).toBe(true);

      // An idle local connection must not claim the session or see buffered output.
      const squatterSocket = net.createConnection({ host: "127.0.0.1", port });
      squatter = squatterSocket;
      let squatterReceived = "";
      squatterSocket.setEncoding("utf8");
      squatterSocket.on("data", (chunk: string) => {
        squatterReceived += chunk;
      });
      squatterSocket.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        squatterSocket.once("connect", () => resolve());
        squatterSocket.once("error", reject);
      });

      // A peer presenting the wrong token is disconnected outright.
      const badPeer = net.createConnection({ host: "127.0.0.1", port });
      badPeer.on("error", () => undefined);
      const badPeerClosed = new Promise<void>((resolve) => badPeer.once("close", () => resolve()));
      badPeer.once("connect", () => badPeer.write(`${JSON.stringify({ token: "wrong-token", type: "stdinEnd" })}\n`));
      await badPeerClosed;

      // The authenticated proxy still attaches and receives the buffered output.
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("guarded-out\n");
      expect(squatterReceived).toBe("");
    } finally {
      squatter?.destroy();
      await bridge?.stop();
    }
  });

  it("streams sandbox process session output before the remote child exits", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-stream-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "streaming-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  if (chunk.includes('ping')) {",
        "    process.stdout.write('delta:ping\\n');",
        "    process.stderr.write('trace:ping\\n');",
        "  }",
        "  if (chunk.includes('finish')) process.exit(0);",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
      "utf8",
    );
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner: createLocalSandboxRunner(),
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-stream",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async () => {},
    });
    expect(bridge).not.toBeNull();

    const child = spawn(bridge!.agentCommand, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let exited = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Timed out waiting for streaming process session proxy."));
      }, 5000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (exitCode) => {
        exited = true;
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });

    try {
      child.stdin.write("ping\n");
      await waitForCondition(
        () => stdout.includes("delta:ping\n") && stderr.includes("trace:ping\n"),
        "Timed out waiting for live process session output.",
        3000,
      );
      expect(exited).toBe(false);

      child.stdin.end("finish\n");
      await expect(exitPromise).resolves.toBe(0);
    } finally {
      if (!exited) {
        child.kill("SIGKILL");
        await exitPromise.catch(() => undefined);
      }
      await bridge?.stop();
    }
  });

  it("logs and recovers from a transient mid-batch event read failure without losing order or escalating", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-mid-batch-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "mid-batch-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdout.write('AAA\\n');",
        "setTimeout(() => process.stdout.write('BBB\\n'), 20);",
        "setTimeout(() => process.stdout.write('CCC\\n'), 40);",
        "setTimeout(() => process.exit(0), 400);",
      ].join("\n"),
      "utf8",
    );

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    // Fail the very first read of the second event file (000000000002.json)
    // exactly once. The poll loop must not throw, must not deliver the third
    // event ahead of it, and must retry it (and anything after it) on the
    // next cycle.
    const runner = createProcessSessionEventFaultInjectingRunner({
      base: createLocalSandboxRunner(),
      failRead: (fileName, attempt) => fileName === "000000000002.json" && attempt === 1,
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-mid-batch",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });
    expect(bridge).not.toBeNull();

    try {
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("AAA\nBBB\nCCC\n");
      expect(result.stderr).toBe("");
      // A single-file read failure must still count as a failed poll cycle
      // (the events read before it, AAA, are still delivered), but since the
      // very next cycle successfully reads and delivers the rest, the streak
      // resets to 0 and the session never escalates to the fatal teardown.
      const failureLogLines = combinedStream(logs, "stderr")
        .split("\n")
        .filter((line) => line.includes("ACP process session bridge poll failed"));
      expect(failureLogLines).toHaveLength(1);
      expect(failureLogLines[0]).toContain("000000000002.json");
      expect(failureLogLines[0]).toContain("(attempt 1/5)");
    } finally {
      await bridge?.stop();
    }
  });

  it("escalates to the fatal frame after 5 consecutive cycles of a persistently failing single event file", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-persistent-bad-file-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "persistent-bad-file-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdout.write('EARLY\\n');",
        "setTimeout(() => process.stdout.write('LATER\\n'), 20);",
        "setTimeout(() => process.exit(0), 10_000);",
      ].join("\n"),
      "utf8",
    );

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    // The second event file never reads successfully, on any attempt. Every
    // poll cycle after the first therefore stops the batch at that same
    // file forever: this is the livelock this fix closes, so it must be
    // reported (logged, counted) rather than silently retried at 100ms with
    // no escalation.
    const runner = createProcessSessionEventFaultInjectingRunner({
      base: createLocalSandboxRunner(),
      failRead: (fileName) => fileName === "000000000002.json",
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-persistent-bad-file",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });
    expect(bridge).not.toBeNull();

    try {
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      // The first event (EARLY) is delivered exactly once before the batch
      // reader hits the permanently bad file and stops; LATER is never
      // reached (it sits behind the bad file in sequence order) and the
      // session tears itself down with the fatal frame instead of looping
      // forever.
      expect(result.stdout).toBe("EARLY\n");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("000000000002.json");

      const failureLogLines = combinedStream(logs, "stderr")
        .split("\n")
        .filter((line) => line.includes("ACP process session bridge poll failed"));
      expect(failureLogLines).toHaveLength(5);
      expect(failureLogLines[0]).toContain("(attempt 1/5)");
      expect(failureLogLines[4]).toContain("(attempt 5/5)");
    } finally {
      await bridge?.stop();
    }
  });

  it("stops delivering at a mid-batch malformed event, keeps the watermark behind it, and re-delivers on retry", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-malformed-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "malformed-event-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdout.write('FIRST\\n');",
        "setTimeout(() => process.stdout.write('SECOND\\n'), 20);",
        "setTimeout(() => process.exit(0), 400);",
      ].join("\n"),
      "utf8",
    );

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    // Corrupt the body of the second event file on its first read only (the
    // read itself succeeds, but the JSON is garbage), then let subsequent
    // reads through untouched so the retry on the next cycle sees the real
    // (valid) body. This simulates a JSON.parse throw mid-batch, distinct
    // from a read failure: readRemoteJsonFiles hands the event back to
    // poll() as successfully read, and it is poll()'s own parse/delivery
    // step that fails.
    let corrupted = false;
    const base = createLocalSandboxRunner();
    const runner = {
      execute: async (execInput: Parameters<typeof base.execute>[0]) => {
        const result = await base.execute(execInput);
        const script = (execInput.args?.[1] ?? "").trim();
        const readMatch = /^base64 < '([^']*\/events\/000000000002\.json)'$/.exec(script);
        if (readMatch && !corrupted && result.exitCode === 0) {
          corrupted = true;
          return { ...result, stdout: Buffer.from("not valid json", "utf8").toString("base64") };
        }
        return result;
      },
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-malformed",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });
    expect(bridge).not.toBeNull();

    try {
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      // Both events are eventually delivered in order, exactly once: the
      // corrupted read is retried (with valid JSON) on the next cycle
      // rather than being skipped or duplicated.
      expect(result.stdout).toBe("FIRST\nSECOND\n");
      const failureLogLines = combinedStream(logs, "stderr")
        .split("\n")
        .filter((line) => line.includes("ACP process session bridge poll failed"));
      expect(failureLogLines).toHaveLength(1);
      expect(failureLogLines[0]).toContain("000000000002.json");
      expect(failureLogLines[0]).toContain("(attempt 1/5)");
    } finally {
      await bridge?.stop();
    }
  });

  it("tolerates transient poll failures, resets the streak on success, and escalates only after 5 consecutive failures", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-poll-failures-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "silent-acp-child.mjs");
    await writeFile(childPath, "setTimeout(() => process.exit(0), 10_000);", "utf8");

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    // Fail cycles 1-2, succeed cycle 3 (must reset the consecutive-failure
    // counter back to 0), then fail 5 cycles in a row (4-8) to cross the
    // escalation threshold on the 5th consecutive failure.
    const failingCycles = new Set([1, 2, 4, 5, 6, 7, 8]);
    const runner = createProcessSessionEventFaultInjectingRunner({
      base: createLocalSandboxRunner(),
      failList: (attempt) => failingCycles.has(attempt),
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-poll-failures",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });
    expect(bridge).not.toBeNull();

    try {
      // A single transient failure (well under the threshold) must not tear
      // the session down: the proxy connects and simply waits, since no
      // fatal frame is delivered yet at cycle 1 or 2.
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("simulated event listing failure");

      const failureLogLines = combinedStream(logs, "stderr")
        .split("\n")
        .filter((line) => line.includes("ACP process session bridge poll failed"));
      expect(failureLogLines).toHaveLength(7);
      expect(failureLogLines[0]).toContain("(attempt 1/5)");
      expect(failureLogLines[1]).toContain("(attempt 2/5)");
      // Cycle 3 succeeded, so the streak restarts from 1 rather than
      // continuing to 3.
      expect(failureLogLines[2]).toContain("(attempt 1/5)");
      expect(failureLogLines[3]).toContain("(attempt 2/5)");
      expect(failureLogLines[4]).toContain("(attempt 3/5)");
      expect(failureLogLines[5]).toContain("(attempt 4/5)");
      expect(failureLogLines[6]).toContain("(attempt 5/5)");
    } finally {
      await bridge?.stop();
    }
  });

  it("logs a warning and never re-delivers an event whose remove call keeps failing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-remove-failure-"));
    cleanupDirs.push(rootDir);
    const childPath = path.join(rootDir, "single-shot-acp-child.mjs");
    await writeFile(
      childPath,
      [
        "process.stdout.write('hello\\n');",
        "setTimeout(() => process.exit(0), 500);",
      ].join("\n"),
      "utf8",
    );

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    // The remove call always fails, so the event file is left on disk on
    // every cycle. Without a delivery watermark this would cause the same
    // event to be re-listed, re-read, and re-delivered indefinitely.
    const runner = createProcessSessionEventFaultInjectingRunner({
      base: createLocalSandboxRunner(),
      failRemove: () => true,
    });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };

    const bridge = await startAdapterExecutionTargetProcessSessionBridge({
      runId: "run-process-session-remove-failure",
      target,
      runtimeRootDir: path.posix.join(rootDir, ".paperclip-runtime", "acpx"),
      adapterKey: "acpx",
      command: process.execPath,
      args: [childPath],
      cwd: rootDir,
      env: {},
      timeoutSec: 5,
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });
    expect(bridge).not.toBeNull();

    try {
      const result = await runProxyWithInput(bridge!.agentCommand, "");
      expect(result.code).toBe(0);
      // "hello" must be delivered exactly once even though its event file
      // was never successfully removed and kept being re-listed.
      expect(result.stdout).toBe("hello\n");
      expect(combinedStream(logs, "stderr")).toMatch(
        /failed to remove processed event file.*000000000001\.json/,
      );
    } finally {
      await bridge?.stop();
    }
  });

  it("applies the remote sandbox fallback when adapter timeoutSec is unset", () => {
    const sandboxTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner: createLocalSandboxRunner(),
    };

    // The sandbox default is a 4h wall-clock backstop matching the recovery
    // watchdog critical threshold (ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS);
    // the output-inactivity monitor remains the primary hang detector.
    expect(DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC).toBe(4 * 60 * 60);
    expect(resolveAdapterExecutionTargetTimeoutSec(sandboxTarget, 0)).toBe(
      DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
    );
    expect(resolveAdapterExecutionTargetTimeoutSec(sandboxTarget, 90)).toBe(90);
    expect(resolveAdapterExecutionTargetTimeoutSec({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/workspace",
      spec: {
        host: "127.0.0.1",
        port: 22,
        username: "fixture",
        remoteWorkspacePath: "/workspace",
        remoteCwd: "/workspace",
        privateKey: "KEY",
        knownHosts: "host key",
        strictHostKeyChecking: true,
      },
    }, 0)).toBe(0);
    expect(resolveAdapterExecutionTargetTimeoutSec({ kind: "local" }, 0)).toBe(0);
  });

  it("reports which knob produced the resolved timeout", () => {
    const sandboxTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner: createLocalSandboxRunner(),
    };

    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 0)).toEqual({
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      source: "sandbox_default",
    });
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 90)).toEqual({
      timeoutSec: 90,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, 0)).toEqual({
      timeoutSec: 0,
      source: "unlimited",
    });
    // Fractional (sub-second) configured timeouts are preserved rather than
    // floored to 0, which would silently mean "no timeout".
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, 0.01)).toEqual({
      timeoutSec: 0.01,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 0.5)).toEqual({
      timeoutSec: 0.5,
      source: "configured",
    });
  });

  it("treats a negative timeoutSec as the explicit no-timeout opt-out, even on sandbox targets", () => {
    const sandboxTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner: createLocalSandboxRunner(),
    };

    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, -1)).toEqual({
      timeoutSec: 0,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, -1)).toEqual({
      timeoutSec: 0,
      source: "configured",
    });
    expect(resolveAdapterExecutionTargetTimeoutSec(sandboxTarget, -1)).toBe(0);

    // Explicit zero intentionally does NOT opt out: the adapter config UI
    // persists the schema default of 0 for untouched fields, so a stored
    // timeoutSec=0 cannot be read as operator intent. It keeps the sandbox
    // backstop; the documented opt-out is a negative value.
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, 0)).toEqual({
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      source: "sandbox_default",
    });
    // Unset behaves like zero.
    expect(resolveAdapterExecutionTargetTimeout(sandboxTarget, undefined)).toEqual({
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      source: "sandbox_default",
    });
    expect(resolveAdapterExecutionTargetTimeout({ kind: "local" }, undefined)).toEqual({
      timeoutSec: 0,
      source: "unlimited",
    });
  });

  it("formats self-describing timeout errors naming the timer and knob", () => {
    expect(
      formatAdapterExecutionTimeoutErrorMessage({
        timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
        source: "sandbox_default",
      }),
    ).toBe(
      "Run exceeded the adapter execution timeout (timeoutSec=14400, sandbox default). " +
        "Set adapterConfig.timeoutSec to raise it.",
    );
    expect(
      formatAdapterExecutionTimeoutErrorMessage({ timeoutSec: 1800, source: "configured" }),
    ).toBe(
      "Run exceeded the adapter execution timeout (timeoutSec=1800, configured via adapterConfig.timeoutSec). " +
        "Set adapterConfig.timeoutSec to raise it.",
    );
  });

  it("formats the start-of-run timeout log line with the resolved value and source", () => {
    expect(
      formatAdapterExecutionTimeoutStartLogLine({
        timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
        source: "sandbox_default",
      }),
    ).toBe(
      "Adapter execution timeout: timeoutSec=14400 (sandbox default; set adapterConfig.timeoutSec to override).",
    );
    expect(
      formatAdapterExecutionTimeoutStartLogLine({ timeoutSec: 900, source: "configured" }),
    ).toBe(
      "Adapter execution timeout: timeoutSec=900 (configured via adapterConfig.timeoutSec; set adapterConfig.timeoutSec to override).",
    );
    expect(
      formatAdapterExecutionTimeoutStartLogLine({ timeoutSec: 0, source: "unlimited" }),
    ).toBe(
      "Adapter execution timeout: none (no adapter wall-clock timeout for this target; set adapterConfig.timeoutSec to add one).",
    );
    // Negative opt-out resolves to { timeoutSec: 0, source: "configured" }.
    expect(
      formatAdapterExecutionTimeoutStartLogLine({ timeoutSec: 0, source: "configured" }),
    ).toBe(
      "Adapter execution timeout: none (explicitly disabled via adapterConfig.timeoutSec; set it to a positive value to add one).",
    );
  });

  it("uses the caller timeout override when installing a missing sandbox command", async () => {
    const runner = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "/usr/bin/opencode\n",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      timeoutMs: 300_000,
      runner,
    };

    await ensureAdapterExecutionTargetCommandResolvable(
      "opencode",
      target,
      "/local/workspace",
      {},
      { installCommand: "npm install -g opencode", timeoutSec: 1800 },
    );

    expect(runner.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      command: "sh",
      args: ["-c", "npm install -g opencode"],
      timeoutMs: 1_800_000,
    }));
  });

  describe("command resolvability on a pre-baked (managed) sandbox", () => {
    // `adapterConfig.command` is a free-form string. On a managed sandbox the
    // image is fixed and pre-baked, so a command that is not part of it can
    // never resolve. A prod user set command="kimi" on an opencode agent and
    // every run burned the full 14400s timeout on a network install that
    // locked egress was never going to let through, then reported that the CLI
    // was "not installed or not on PATH", which reads as something a retry or
    // an operator could fix.
    const prebakedTarget = (): AdapterSandboxExecutionTarget => ({
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      timeoutMs: 300_000,
      prebakedRuntime: true,
      runner: {
        execute: vi.fn().mockResolvedValue({
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      },
    });

    it("never attempts a network install for a command the pre-baked image lacks", async () => {
      const target = prebakedTarget();
      await expect(
        ensureAdapterExecutionTargetCommandResolvable("kimi", target, "/local/workspace", {}, {
          installCommand: "npm install -g kimi",
          timeoutSec: 14400,
        }),
      ).rejects.toThrow();

      // One probe, no install: locked egress makes the install stall until the
      // adapter's whole timeout budget is gone.
      const runner = target.runner as { execute: ReturnType<typeof vi.fn> };
      expect(runner.execute).toHaveBeenCalledTimes(1);
      for (const call of runner.execute.mock.calls) {
        expect(String(call[0].args?.[1] ?? "")).not.toContain("npm install");
      }
    });

    it("says the image is fixed, rather than implying the CLI could be installed", async () => {
      const target = prebakedTarget();
      let thrown: unknown;
      try {
        await ensureAdapterExecutionTargetCommandResolvable("kimi", target, "/local/workspace", {}, {
          installCommand: "npm install -g kimi",
        });
      } catch (err) {
        thrown = err;
      }
      const message = (thrown as Error).message;
      expect(message).toContain("kimi");
      expect(message).not.toContain("not installed or not on PATH");
      expect(message.toLowerCase()).toContain("pre-baked");
    });

    it("still installs on a sandbox that is not pre-baked", async () => {
      const runner = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            exitCode: 1,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            pid: null,
            startedAt: new Date().toISOString(),
          })
          .mockResolvedValueOnce({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            pid: null,
            startedAt: new Date().toISOString(),
          })
          .mockResolvedValueOnce({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "/usr/bin/opencode\n",
            stderr: "",
            pid: null,
            startedAt: new Date().toISOString(),
          }),
      };
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
        timeoutMs: 300_000,
        runner,
      };
      await ensureAdapterExecutionTargetCommandResolvable("opencode", target, "/local/workspace", {}, {
        installCommand: "npm install -g opencode",
      });
      expect(runner.execute).toHaveBeenCalledTimes(3);
    });
  });

  describe("pre-baked (managed) sandbox runtime install", () => {
    it("fails fast with a runtime-image-mismatch error and never attempts an install when the CLI is missing", async () => {
      // The detect probe reports the CLI missing (exit 1). On a pre-baked
      // managed image this means the run landed on the wrong runtime image, so
      // we must fail immediately, NOT run the network install (blocked egress).
      const runner = {
        execute: vi.fn().mockResolvedValue({
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      };
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
        timeoutMs: 300_000,
        prebakedRuntime: true,
        runner,
      };

      let thrown: unknown;
      try {
        await ensureAdapterExecutionTargetRuntimeCommandInstalled({
          runId: "run-prebaked",
          target,
          detectCommand: "gemini",
          installCommand:
            "if ! command -v 'gemini' >/dev/null 2>&1; then npm install -g @google/gemini-cli; fi",
          cwd: "/local/workspace",
          env: {},
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AdapterRuntimeImageMismatchError);
      expect(isAdapterRuntimeImageMismatchError(thrown)).toBe(true);
      expect((thrown as AdapterRuntimeImageMismatchError).code).toBe(
        "adapter_runtime_image_mismatch",
      );
      expect((thrown as AdapterRuntimeImageMismatchError).adapterCommand).toBe("gemini");
      expect((thrown as Error).message).toContain("gemini");

      // Exactly one runner call: the detect probe. The install was never run.
      expect(runner.execute).toHaveBeenCalledTimes(1);
      const probeArgs = runner.execute.mock.calls[0][0];
      expect(String(probeArgs.args?.[1] ?? "")).toContain("command -v");
      expect(String(probeArgs.args?.[1] ?? "")).not.toContain("npm install");
    });

    it("passes when the pre-baked image already carries the CLI, without installing", async () => {
      const runner = {
        execute: vi.fn().mockResolvedValue({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      };
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
        timeoutMs: 300_000,
        prebakedRuntime: true,
        runner,
      };

      await expect(
        ensureAdapterExecutionTargetRuntimeCommandInstalled({
          runId: "run-prebaked-ok",
          target,
          detectCommand: "gemini",
          installCommand: "npm install -g @google/gemini-cli",
          cwd: "/local/workspace",
          env: {},
        }),
      ).resolves.toBeUndefined();

      // Only the detect probe ran; no install attempt.
      expect(runner.execute).toHaveBeenCalledTimes(1);
    });

    it("retries a detect probe that never answered before judging the image", async () => {
      // `command -v` returns in microseconds. A timeout is the exec channel
      // failing to answer (a dropped WebSocket, an apiserver blip), never
      // evidence about what the image contains, so the probe is asked again.
      const runner = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            exitCode: null,
            signal: null,
            timedOut: true,
            stdout: "",
            stderr: "",
            pid: null,
            startedAt: new Date().toISOString(),
          })
          .mockResolvedValueOnce({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            pid: null,
            startedAt: new Date().toISOString(),
          }),
      };
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
        timeoutMs: 300_000,
        prebakedRuntime: true,
        runner,
      };

      await expect(
        ensureAdapterExecutionTargetRuntimeCommandInstalled({
          runId: "run-prebaked-flaky-probe",
          target,
          detectCommand: "gemini",
          installCommand: "npm install -g @google/gemini-cli",
          cwd: "/local/workspace",
          env: {},
        }),
      ).resolves.toBeUndefined();

      // Probed twice, installed never.
      expect(runner.execute).toHaveBeenCalledTimes(2);
      for (const call of runner.execute.mock.calls) {
        expect(String(call[0].args?.[1] ?? "")).not.toContain("npm install");
      }
    });

    it("blames the exec channel, not the image, when the probe never answers at all", async () => {
      // Two companies were told in August that their run "landed on the wrong
      // runtime image" when the probe had simply timed out. That reads as a
      // permanent platform fault, it is wrong, and it spends the one-shot
      // image-mismatch self-heal on a problem no new image can fix.
      const runner = {
        execute: vi.fn().mockResolvedValue({
          exitCode: null,
          signal: null,
          timedOut: true,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      };
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
        timeoutMs: 300_000,
        prebakedRuntime: true,
        runner,
      };

      let thrown: unknown;
      try {
        await ensureAdapterExecutionTargetRuntimeCommandInstalled({
          runId: "run-prebaked-dead-channel",
          target,
          detectCommand: "gemini",
          installCommand: "npm install -g @google/gemini-cli",
          cwd: "/local/workspace",
          env: {},
        });
      } catch (err) {
        thrown = err;
      }

      expect(isAdapterRuntimeImageMismatchError(thrown)).toBe(false);
      expect(isAdapterSandboxProbeUnansweredError(thrown)).toBe(true);
      expect((thrown as AdapterSandboxProbeUnansweredError).code).toBe("sandbox_exec_timeout");
      expect((thrown as Error).message).not.toContain("wrong runtime image");
      expect((thrown as Error).message).toContain("gemini");
    });
  });

  it("runs shell commands through the same runner", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "/home/sandbox",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetShellCommand("run-2", target, 'printf %s "$HOME"', {
      cwd: "/local/workspace",
      env: {},
      timeoutSec: 7,
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "sh",
      args: ["-c", 'printf %s "$HOME"'],
      cwd: "/workspace",
      timeoutMs: 7000,
    }));
  });

  it("strips inherited host identity env before sandbox execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");
    vi.stubEnv("TMPDIR", "/var/folders/local/T");

    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetProcess("run-1b", target, "agent-cli", ["--json"], {
      cwd: "/local/workspace",
      env: {
        PATH: "/host/bin:/usr/bin",
        HOME: "/Users/local",
        TMPDIR: "/var/folders/local/T",
        SAFE_VALUE: "visible",
      },
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        SAFE_VALUE: "visible",
      },
    }));
  });

  it("preserves explicit remote identity env overrides for sandbox execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");

    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetProcess("run-1c", target, "agent-cli", ["--json"], {
      cwd: "/local/workspace",
      env: {
        PATH: "/custom/remote/bin:/usr/bin",
        HOME: "/home/sandbox",
        SAFE_VALUE: "visible",
      },
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        PATH: "/custom/remote/bin:/usr/bin",
        HOME: "/home/sandbox",
        SAFE_VALUE: "visible",
      },
    }));
  });

  it("treats SSH targets as bridge-only", () => {
    const target = {
      kind: "remote" as const,
      transport: "ssh" as const,
      remoteCwd: "/workspace",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/workspace",
        remoteCwd: "/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };

    expect(adapterExecutionTargetUsesPaperclipBridge(target)).toBe(true);
    expect(adapterExecutionTargetSessionIdentity(target)).toEqual({
      transport: "ssh",
      host: "ssh.example.test",
      port: 22,
      username: "paperclip",
      remoteCwd: "/workspace",
    });
  });

  it("uses the provider-declared shell for sandbox helper commands", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "/home/sandbox",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "custom-provider",
      shellCommand: "bash",
      remoteCwd: "/workspace",
      runner,
    };

    await runAdapterExecutionTargetShellCommand("run-2b", target, 'printf %s "$HOME"', {
      cwd: "/local/workspace",
      env: {},
      timeoutSec: 7,
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "bash",
      args: ["-c", 'printf %s "$HOME"'],
      cwd: "/workspace",
      timeoutMs: 7000,
    }));
  });

  it("starts a localhost Paperclip bridge for sandbox targets in bridge mode", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(bridge?.env.PAPERCLIP_API_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(bridge?.env.PAPERCLIP_API_KEY).not.toBe("real-run-jwt");
      expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");

      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, {
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          accept: "application/json",
        },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("creates a sandbox run log tail factory when bridge streaming is enabled", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-stream-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      streamRunLogs: true,
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-stream",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: "http://127.0.0.1:9",
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });
    try {
      expect(bridge?.runLogTail).toBeTruthy();
      expect(combinedStream(logs, "stdout")).toContain("Sandbox run log streaming enabled");

      const wrapped = bridge!.runLogTail!.create().wrapCommand("agent-cli", ["--message", "hello world"]);
      expect(wrapped.command).toBe("sh");
      expect(wrapped.args.join("\n")).toContain("tee -a");
      expect(wrapped.args.join("\n")).toContain("agent-cli");
    } finally {
      await bridge?.stop();
    }
  });

  it("defaults sandbox run log streaming on and honors the explicit opt-out", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-stream-default-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const baseTarget: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const defaultBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-stream-default",
      target: baseTarget,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: "http://127.0.0.1:9",
    });
    try {
      expect(defaultBridge?.runLogTail).toBeTruthy();
    } finally {
      await defaultBridge?.stop();
    }

    const optOutBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-stream-opt-out",
      target: { ...baseTarget, streamRunLogs: false },
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: "http://127.0.0.1:9",
    });
    try {
      expect(optOutBridge?.runLogTail ?? null).toBeNull();
    } finally {
      await optOutBridge?.stop();
    }
  });

  it("tails sandbox run log chunks with byte offsets and dedupes the final batch", async () => {
    const stdoutText = "stdout-abc\n";
    const stderrText = "stderr-xyz\n";
    const stdoutBytes = Buffer.from(stdoutText, "utf8");
    const stderrBytes = Buffer.from(stderrText, "utf8");
    const stdoutOffsets: number[] = [];
    const stderrOffsets: number[] = [];
    const events: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    const runner = {
      execute: vi.fn(async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
      }) => {
        const script = input.args?.[1] ?? "";
        const offsets = [...script.matchAll(/tail -c \+(\d+) /g)].map((match) => Number(match[1]));
        const stdoutStart = Math.max(0, (offsets[0] ?? 1) - 1);
        const stderrStart = Math.max(0, (offsets[1] ?? 1) - 1);
        stdoutOffsets.push(stdoutStart + 1);
        stderrOffsets.push(stderrStart + 1);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: encodeTailTick(
            stdoutBytes.subarray(stdoutStart, stdoutStart + 4),
            stderrBytes.subarray(stderrStart, stderrStart + 4),
          ),
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        };
      }),
    };

    const tail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/workspace",
      logsDir: "/workspace/.paperclip-runtime/codex/paperclip-bridge/queue/logs",
      pollIntervalMs: 1,
      maxChunkBytesPerTick: 4,
      tickTimeoutMs: 50,
    }).create();

    tail.start(async (stream, chunk) => {
      events.push({ stream, chunk });
    });

    await waitForCondition(
      () => combinedStream(events, "stdout") === stdoutText && combinedStream(events, "stderr") === stderrText,
      "run log tail did not stream expected stdout/stderr chunks",
    );

    await tail.finish({ stdout: stdoutText, stderr: stderrText });

    expect(combinedStream(events, "stdout")).toBe(stdoutText);
    expect(combinedStream(events, "stderr")).toBe(stderrText);
    expect(stdoutOffsets.slice(0, 3)).toEqual([1, 5, 9]);
    expect(stderrOffsets.slice(0, 3)).toEqual([1, 5, 9]);
    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "sh",
      cwd: "/workspace",
      env: { PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge" },
      timeoutMs: 50,
    }));
  });

  it("emits only the unstreamed final suffix when the tail loop stops early", async () => {
    const finalStdout = "prefix suffix\n";
    const finalBytes = Buffer.from(finalStdout, "utf8");
    const events: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    const runner = {
      execute: vi.fn(async (input: { args?: string[] }) => {
        const script = input.args?.[1] ?? "";
        const offsets = [...script.matchAll(/tail -c \+(\d+) /g)].map((match) => Number(match[1]));
        const stdoutStart = Math.max(0, (offsets[0] ?? 1) - 1);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: encodeTailTick(finalBytes.subarray(stdoutStart, stdoutStart + 7), Buffer.alloc(0)),
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        };
      }),
    };

    const tail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/workspace",
      logsDir: "/workspace/.paperclip-runtime/codex/paperclip-bridge/queue/logs",
      pollIntervalMs: 1,
      maxChunkBytesPerTick: 7,
      tickTimeoutMs: 50,
    }).create();

    tail.start(async (stream, chunk) => {
      events.push({ stream, chunk });
    });
    await waitForCondition(() => combinedStream(events, "stdout").length >= 7, "run log tail did not emit prefix");
    await tail.finish({ stdout: finalStdout, stderr: "" });

    expect(combinedStream(events, "stdout")).toBe(finalStdout);
    expect(events.filter((event) => event.stream === "stdout").map((event) => event.chunk).join("|"))
      .toBe("prefix |suffix\n");
  });

  it("delivers the final batch and a warning when run log polling degrades", async () => {
    const events: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "tail failed",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };

    const tail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/workspace",
      logsDir: "/workspace/.paperclip-runtime/codex/paperclip-bridge/queue/logs",
      pollIntervalMs: 1,
      tickTimeoutMs: 50,
      maxConsecutiveFailures: 1,
    }).create();

    tail.start(async (stream, chunk) => {
      events.push({ stream, chunk });
    });
    await waitForCondition(() => runner.execute.mock.calls.length >= 1, "run log tail did not poll before finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tail.finish({ stdout: "final out\n", stderr: "final err\n" });

    expect(combinedStream(events, "stdout")).toBe("final out\n");
    expect(combinedStream(events, "stderr")).toBe(
      "final err\n[paperclip] Run log streaming degraded during the run; remaining output was delivered at completion.\n",
    );
  });

  it("exposes the Paperclip bridge to the sandbox shell surface", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-shell-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "claude");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge shell test API server to listen on a TCP port.");
    }

    const delegateRunner = createLocalSandboxRunner();
    const runner = {
      execute: vi.fn(async (input: Parameters<typeof delegateRunner.execute>[0]) => delegateRunner.execute(input)),
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner,
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-shell",
      target,
      runtimeRootDir,
      adapterKey: "claude",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(bridge).not.toBeNull();
      const shellProbe = [
        "const url = `${process.env.PAPERCLIP_API_URL}/api/agents/me`;",
        "fetch(url, { headers: { authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`, accept: 'application/json' } })",
        "  .then(async (response) => {",
        "    const body = await response.json();",
        "    process.stdout.write(JSON.stringify({",
        "      status: response.status,",
        "      body,",
        "      bridgeMode: process.env.PAPERCLIP_API_BRIDGE_MODE,",
        "    }));",
        "  })",
        "  .catch((error) => {",
        "    console.error(error instanceof Error ? error.stack : String(error));",
        "    process.exit(1);",
        "  });",
      ].join("\n");

      const result = await runAdapterExecutionTargetShellCommand(
        "run-bridge-shell",
        target,
        `${shellQuote(process.execPath)} -e ${shellQuote(shellProbe)}`,
        {
          cwd: remoteCwd,
          env: bridge!.env,
          timeoutSec: 15,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        status: 200,
        body: { ok: true },
        bridgeMode: "queue_v1",
      });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("real-run-jwt");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(bridge!.env.PAPERCLIP_API_KEY);
      const runnerCommandText = JSON.stringify(
        runner.execute.mock.calls.map(([call]) => ({
          command: call.command,
          args: call.args,
        })),
      );
      expect(runnerCommandText).not.toContain("real-run-jwt");
      expect(runnerCommandText).not.toContain(bridge!.env.PAPERCLIP_API_KEY);
      const runtimeFiles = (await readRuntimeTextFiles(runtimeRootDir)).join("\n");
      expect(runtimeFiles).not.toContain("real-run-jwt");
      expect(runtimeFiles).not.toContain(bridge!.env.PAPERCLIP_API_KEY);
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge-shell",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("uses the effective adapter timeout when starting the sandbox callback bridge", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-timeout-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const delegateRunner = createLocalSandboxRunner();
    const runner = {
      execute: vi.fn(async (input: Parameters<typeof delegateRunner.execute>[0]) => delegateRunner.execute(input)),
    };
    const apiServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge timeout test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "cloudflare",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner,
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-timeout",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(bridge).not.toBeNull();
      expect(runner.execute).toHaveBeenCalled();
      expect(
        runner.execute.mock.calls.some(([input]) => input.timeoutMs === DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC * 1000),
      ).toBe(true);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("fails an oversized host response with a non-retryable 409 so a committed mutation never repeats", async () => {
    // The host receives the request and commits the mutation, then sends a
    // response body over the size limit. The forward reads the body after the
    // fetch resolves, so the read failure happens after the host commit. The
    // forward must return a non-retryable 504 with the indeterminate outcome, not
    // a retryable 502. The in-sandbox server maps the indeterminate 504 to a
    // non-retryable 409. A retryable status would repeat the mutation with a new
    // request id outside the broker deduplication set.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-limit-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    // The host body sits over the size limit, so the forward read fails. The
    // limit stays above the small indeterminate marker the forward returns, so the
    // marker still reaches the server for the 504-to-409 map.
    const largeBody = "x".repeat(1024);
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(201, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(largeBody, "utf8")),
      });
      res.end(largeBody);
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-limit",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
      maxBodyBytes: 512,
    });
    try {
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/issue-1/comments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: "Status update." }),
      });

      // The indeterminate 504 maps to a non-retryable 409, so the caller does not
      // retry the committed mutation.
      expect(response.status).toBe(409);
      expect(response.headers.get("x-paperclip-bridge-outcome")).toBe("indeterminate");
      await expect(response.json()).resolves.toEqual({
        error: "Bridge response body exceeded the configured size limit of 512 bytes.",
        outcome: "indeterminate",
        retryable: false,
      });
      // The host ran the mutation exactly once. It never receives a retry.
      expect(requests).toEqual([{
        method: "POST",
        url: "/api/issues/issue-1/comments",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge-limit",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("keeps an oversized host response for a safe method retryable so the read failure does not turn terminal", async () => {
    // A GET never changes host state, so a retry cannot double-apply a mutation.
    // The host sends a response body over the size limit, so the forward read
    // fails after the fetch resolves. For a safe method the forward must return a
    // retryable 502 with no indeterminate marker, not the non-retryable 504 the
    // forward returns for a mutating method. The in-sandbox server passes the 502
    // through, so the caller can retry the safe read.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-safe-limit-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const largeBody = "x".repeat(1024);
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(largeBody, "utf8")),
      });
      res.end(largeBody);
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge test API server to listen on a TCP port.");
    }

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-safe-limit",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
      maxBodyBytes: 512,
    });
    try {
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/issue-1`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
        },
      });

      // The forward returns a retryable 502 with no indeterminate marker, so the
      // server passes it through instead of mapping it to a terminal 409.
      expect(response.status).toBe(502);
      expect(response.headers.get("x-paperclip-bridge-outcome")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        error: "Bridge response body exceeded the configured size limit of 512 bytes.",
      });
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/issues/issue-1",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge-safe-limit",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("forwards bridge traffic to the local listen origin even when public API URLs are configured", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-local-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "claude");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: Array<{ method: string; url: string; auth: string | null; runId: string | null }> = [];
    const apiServer = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        auth: req.headers.authorization ?? null,
        runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge local-origin test API server to listen on a TCP port.");
    }

    // Simulate a deployment where a public base URL is configured: server boot
    // exports the public origin via PAPERCLIP_RUNTIME_API_URL / PAPERCLIP_API_URL
    // and the local listen host/port via PAPERCLIP_LISTEN_HOST / PAPERCLIP_LISTEN_PORT.
    // The wildcard listen host must map to the loopback address of the same
    // family (0.0.0.0 -> 127.0.0.1), where the test API server is bound.
    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", "https://public.example.invalid");
    vi.stubEnv("PAPERCLIP_API_URL", "https://public.example.invalid");
    vi.stubEnv("PAPERCLIP_LISTEN_HOST", "0.0.0.0");
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", String(address.port));

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-local",
      target,
      runtimeRootDir,
      adapterKey: "claude",
      hostApiToken: "real-run-jwt",
    });
    try {
      expect(bridge).not.toBeNull();
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, {
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          accept: "application/json",
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/agents/me",
        auth: "Bearer real-run-jwt",
        runId: "run-bridge-local",
      }]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });

  it("lets an explicit hostApiUrl input override the bridge forward target", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-target-bridge-override-"));
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "claude");
    await mkdir(runtimeRootDir, { recursive: true });

    const requests: string[] = [];
    const apiServer = createServer((req, res) => {
      requests.push(req.url ?? "/");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = apiServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the bridge override test API server to listen on a TCP port.");
    }

    // Neither the public URL envs nor the listen host/port should matter when
    // the caller passes an explicit hostApiUrl.
    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", "https://public.example.invalid");
    vi.stubEnv("PAPERCLIP_API_URL", "https://public.example.invalid");
    vi.stubEnv("PAPERCLIP_LISTEN_HOST", "203.0.113.1");
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", "9");

    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };

    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-bridge-override",
      target,
      runtimeRootDir,
      adapterKey: "claude",
      hostApiToken: "real-run-jwt",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
    });
    try {
      expect(bridge).not.toBeNull();
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, {
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          accept: "application/json",
        },
      });

      expect(response.status).toBe(200);
      expect(requests).toEqual(["/api/agents/me"]);
    } finally {
      await bridge?.stop();
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    }
  });
});
