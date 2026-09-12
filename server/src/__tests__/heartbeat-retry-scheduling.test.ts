import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  issueApprovals,
  issueThreadInteractions,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  closeDbClient,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

// Wraps the real implementation so most tests exercise genuine transactional
// writes; a test that needs to prove a rollback overrides one call with
// `mockRejectedValueOnce` and lets every other call fall through untouched.
vi.mock("../services/heartbeat-run-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat-run-events.js")>();
  return { ...actual, appendHeartbeatRunEvent: vi.fn(actual.appendHeartbeatRunEvent) };
});

import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  CONSECUTIVE_IDENTICAL_FAILURE_PAUSE_THRESHOLD,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { environmentRuntimeService } from "../services/environment-runtime.ts";

const mockedAppendHeartbeatRunEvent = vi.mocked(appendHeartbeatRunEvent);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const PROVIDER_QUOTA_TEST_ADAPTER = "provider_quota_test";
const AUTH_FAILURE_TEST_ADAPTER = "auth_failure_test";
const CODEX_AUTH_FAILURE_TEST_ADAPTER = "codex_auth_failure_test";
const IDENTICAL_FAILURE_TEST_ADAPTER = "identical_failure_test";
const TRANSIENT_STORM_TEST_ADAPTER = "transient_storm_test";
const TRANSIENT_STORM_TEST_ERROR_CODE = "inference_upstream_error";
const IDENTICAL_FAILURE_TEST_ERROR_CODE = "stuck_failure_test";
const SETUP_FAILURE_TEST_ADAPTER = "setup_failure_test";

// Optional per-adapter gates: when set, the adapter's execute() blocks on the
// promise before resolving. Tests that need to seed a queued sibling AFTER
// the run under test has already claimed the agent's single concurrency slot
// (mirroring the prod incident's timing) open a gate, wait for the run to
// reach "running", seed the sibling, then release the gate. Left null
// (default), execute() resolves immediately as before.
let authFailureGate: Promise<void> | null = null;
let identicalFailureGate: Promise<void> | null = null;
let transientStormGate: Promise<void> | null = null;
let setupFailureGate: Promise<void> | null = null;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat retry scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

// Waits until the run has left "queued" (i.e. claimQueuedRun has run and it's
// at least "running"). Used to seed a queued sibling AFTER the run under test
// has already claimed the agent's single concurrency slot, so the sibling
// itself is never dequeued first (FIFO by createdAt would otherwise race it
// ahead of the run this test is actually exercising).
async function waitForRunClaimed(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued") return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return await heartbeat.getRun(runId);
}

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// Reproduces the shape of the prod incident (run 5df36a9e): a retry run gets
// enqueued for an agent moments before that agent auto-pauses. Auto-pause must
// cancel it immediately, or it sits in "queued" forever (dequeue skips paused
// agents).
async function seedQueuedSiblingRun(
  db: ReturnType<typeof createDb>,
  input: { companyId: string; agentId: string },
) {
  const siblingId = randomUUID();
  await db.insert(heartbeatRuns).values({
    id: siblingId,
    companyId: input.companyId,
    agentId: input.agentId,
    invocationSource: "assignment",
    status: "queued",
    contextSnapshot: {},
  });
  return siblingId;
}

async function expectSiblingCancelledAsPaused(db: ReturnType<typeof createDb>, siblingId: string) {
  await expect
    .poll(
      () =>
        db
          .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, siblingId))
          .then((rows) => rows[0] ?? null),
      { timeout: 5_000, interval: 50 },
    )
    .toMatchObject({ status: "cancelled", errorCode: "agent_paused" });
  const sibling = await db
    .select({ error: heartbeatRuns.error })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, siblingId))
    .then((rows) => rows[0] ?? null);
  expect(sibling?.error).toContain("paused");
}

describeEmbeddedPostgres("heartbeat bounded retry scheduling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-retry-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: PROVIDER_QUOTA_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "You've hit your session limit - resets at 4pm (America/Chicago).",
        errorCode: "provider_quota",
        errorFamily: "provider_quota",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        retryNotBefore: "2030-04-22T21:00:00.000Z",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          errorFamily: "provider_quota",
          retryNotBefore: "2030-04-22T21:00:00.000Z",
          providerQuotaRetryNotBefore: "2030-04-22T21:00:00.000Z",
        },
      }),
      testEnvironment: async () => ({
        adapterType: PROVIDER_QUOTA_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: IDENTICAL_FAILURE_TEST_ADAPTER,
      execute: async () => {
        if (identicalFailureGate) await identicalFailureGate;
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "Same failure every run.",
          errorCode: IDENTICAL_FAILURE_TEST_ERROR_CODE,
          resultJson: {},
        };
      },
      testEnvironment: async () => ({
        adapterType: IDENTICAL_FAILURE_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      // Fails the same transient-looking way every run, with a deliberately
      // tight retry budget so a single run can exhaust it. Mirrors the real
      // production shape: an OpenRouter key asked for an amazon-bedrock model
      // answers "Unexpected server error", which classifies as a retryable
      // upstream fault forever even though it will never start working.
      type: TRANSIENT_STORM_TEST_ADAPTER,
      execute: async () => {
        if (transientStormGate) await transientStormGate;
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "Unexpected server error. Check server logs for details.",
          errorCode: TRANSIENT_STORM_TEST_ERROR_CODE,
          errorFamily: "transient_upstream" as const,
          resultJson: {
            errorFamily: "transient_upstream",
            transientRetryMaxAttempts: 1,
          },
        };
      },
      testEnvironment: async () => ({
        adapterType: TRANSIENT_STORM_TEST_ADAPTER,
        status: "pass" as const,
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: SETUP_FAILURE_TEST_ADAPTER,
      // Registration only: the agent needs a resolvable adapter type, but the
      // non-retryable-setup-failure test never actually reaches execute(). It
      // injects the failure earlier, at environment lease acquisition (see
      // that test's dedicated heartbeatService instance), matching where
      // isNonRetryableAdapterSetupFailure's real trigger (a k8s sandbox
      // provider rejecting an adapter type) actually throws.
      execute: async () => {
        throw new Error("setup_failure_test adapter should never execute in this suite");
      },
      testEnvironment: async () => ({
        adapterType: SETUP_FAILURE_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: AUTH_FAILURE_TEST_ADAPTER,
      execute: async () => {
        if (authFailureGate) await authFailureGate;
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "Claude authentication required. Connect a provider credential.",
          errorCode: "claude_auth_required",
          resultJson: {},
        };
      },
      testEnvironment: async () => ({
        adapterType: AUTH_FAILURE_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: CODEX_AUTH_FAILURE_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Incorrect API key provided. Connect a valid OpenAI API key.",
        errorCode: "codex_auth_required",
        resultJson: {},
      }),
      testEnvironment: async () => ({
        adapterType: CODEX_AUTH_FAILURE_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    authFailureGate = null;
    identicalFailureGate = null;
    transientStormGate = null;
    setupFailureGate = null;
    // Await every in-flight background heartbeat run to quiescence before the
    // cleanup deletes. heartbeat.invoke claims a run and dispatches its
    // execution fire-and-forget, and that run can schedule a follow-up retry
    // wakeup, so a run or wakeup can still write heartbeat_runs and issues rows
    // when teardown starts. The cleanup deletes issues before heartbeat_runs, so
    // a late write races the deletes and can deadlock or break a foreign key.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupRetryFixture();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeDbClient(db);
    unregisterServerAdapter(PROVIDER_QUOTA_TEST_ADAPTER);
    unregisterServerAdapter(AUTH_FAILURE_TEST_ADAPTER);
    unregisterServerAdapter(CODEX_AUTH_FAILURE_TEST_ADAPTER);
    unregisterServerAdapter(IDENTICAL_FAILURE_TEST_ADAPTER);
    unregisterServerAdapter(SETUP_FAILURE_TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function cleanupRetryFixture() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await cleanupRetryFixtureOnce();
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function cleanupHeartbeatRunDependents() {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
  }

  async function cleanupRetryFixtureOnce() {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(approvals);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await cleanupHeartbeatRunDependents();
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  async function seedRetryFixture(input: {
    runId: string;
    companyId: string;
    agentId: string;
    now: Date;
    errorCode: string;
    errorFamily?: "transient_upstream" | "provider_quota" | null;
    retryNotBefore?: string | null;
    scheduledRetryAttempt?: number;
    resultJson?: Record<string, unknown> | null;
    adapterType?: string;
    agentName?: string;
  }) {
    const adapterType = input.adapterType ?? "codex_local";
    const agentName = input.agentName ?? (adapterType === "claude_local" ? "ClaudeCoder" : "CodexCoder");
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: agentName,
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: input.errorCode,
      finishedAt: input.now,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input.scheduledRetryAttempt ? "transient_failure" : null,
      resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        ...(input.errorFamily ? { errorFamily: input.errorFamily } : {}),
        ...(input.retryNotBefore
          ? {
              retryNotBefore: input.retryNotBefore,
              transientRetryNotBefore: input.retryNotBefore,
            }
          : {}),
        ...input.resultJson,
      },
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: input.now,
      createdAt: input.now,
    });
  }

  it("reuses one failure successor across concurrent and repeated scheduling", async () => {
    const runId = randomUUID(), companyId = randomUUID(), agentId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");
    await seedRetryFixture({ runId, companyId, agentId, now, errorCode: "adapter_failed" });
    const outcomes = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 }),
      heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 }),
    ]);
    expect(outcomes.every((outcome) => outcome.outcome === "scheduled")).toBe(true);
    const children = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(children).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, children[0]!.id));
    await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0, retryReason: "execution_review_participant_recovery" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(1);
  });

  it("retains the failure budget after many pre-provider workspace waits", async () => {
    const runId = randomUUID(), companyId = randomUUID(), agentId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");
    await seedRetryFixture({ runId, companyId, agentId, now, errorCode: "overloaded", errorFamily: "transient_upstream" });
    await db.update(heartbeatRuns).set({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 12,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 1 } }).where(eq(heartbeatRuns.id, runId));
    const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });
    expect(scheduled).toMatchObject({ outcome: "scheduled", run: { scheduledRetryAttempt: 2, scheduledRetryReason: "transient_failure" } });
    if (scheduled.outcome !== "scheduled") throw new Error("Expected a bounded retry");
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "overloaded",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, scheduled.run!.id));
    expect(await heartbeat.scheduleBoundedRetry(scheduled.run!.id, { now, random: () => 0 })).toMatchObject({ outcome: "retry_exhausted" });
  });
  it("records pre-provider quota rejection, schedules the reset-time retry, and leaves the agent idle", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Quota Test",
      role: "engineer",
      status: "idle",
      adapterType: PROVIDER_QUOTA_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("provider_quota");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");

    await expect
      .poll(
        () =>
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.retryOfRunId, run!.id))
            .then((rows) => rows.length),
        { timeout: 5_000, interval: 50 },
      )
      .toBe(1);

    const retryRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe("2030-04-22T21:00:00.000Z");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.providerQuotaRetryNotBefore).toBe(
      "2030-04-22T21:00:00.000Z",
    );
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode ?? null).toBeNull();

    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status, errorReason: agents.errorReason })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toEqual({ status: "idle", errorReason: null });
  });

  it("pauses an agent whose run fails with a permanent auth error instead of re-running it", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Keyless Agent",
      role: "engineer",
      status: "idle",
      adapterType: AUTH_FAILURE_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const gate = createGate();
    authFailureGate = gate.promise;

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    // Seed the queued sibling only after this run has already claimed the
    // agent's single concurrency slot (mirrors the prod incident: the retry
    // run was enqueued 150ms after the failing run started, not before).
    await waitForRunClaimed(heartbeat, run!.id);
    const queuedSiblingId = await seedQueuedSiblingRun(db, { companyId, agentId });
    gate.release();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("claude_auth_required");

    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0]?.status ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toBe("paused");

    // No retry run is scheduled for a permanent auth failure.
    const retryCount = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows.length);
    expect(retryCount).toBe(0);

    const pausedAgent = await db
      .select({ pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(pausedAgent?.pauseReason).toContain("Connect a model key");

    // The invariant manual pause guarantees (no live runs left behind) must
    // also hold for auto-pause: the queued sibling gets cancelled, not left
    // stuck forever behind a paused agent's dequeue skip.
    await expectSiblingCancelledAsPaused(db, queuedSiblingId);
  });

  it("pauses an agent whose run fails with codex_auth_required instead of re-running it", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex Agent With Bad Key",
      role: "engineer",
      status: "idle",
      adapterType: CODEX_AUTH_FAILURE_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("codex_auth_required");

    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0]?.status ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toBe("paused");

    // No retry run is scheduled for a permanent auth failure.
    const retryCount = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows.length);
    expect(retryCount).toBe(0);
  });

  async function seedIdenticalFailureFixture(input: {
    companyId: string;
    agentId: string;
    adapterType?: string;
    priorRuns: Array<{ status: "failed" | "succeeded"; errorCode?: string | null }>;
  }) {
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: "Stuck Agent",
      role: "engineer",
      status: "idle",
      adapterType: input.adapterType ?? IDENTICAL_FAILURE_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    // Oldest first; each row gets an older createdAt so the newly invoked run is
    // always the most recent one.
    const base = Date.now() - input.priorRuns.length * 60_000;
    for (const [index, prior] of input.priorRuns.entries()) {
      const at = new Date(base + index * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "assignment",
        status: prior.status,
        error: prior.status === "failed" ? "Same failure every run." : null,
        errorCode: prior.status === "failed" ? (prior.errorCode ?? IDENTICAL_FAILURE_TEST_ERROR_CODE) : null,
        finishedAt: at,
        resultJson: {},
        contextSnapshot: {},
        createdAt: at,
        updatedAt: at,
      });
    }
  }

  it("pauses an agent after N consecutive failed runs with the same error code", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedIdenticalFailureFixture({
      companyId,
      agentId,
      priorRuns: Array.from(
        { length: CONSECUTIVE_IDENTICAL_FAILURE_PAUSE_THRESHOLD - 1 },
        () => ({ status: "failed" as const }),
      ),
    });

    const gate = createGate();
    identicalFailureGate = gate.promise;

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    await waitForRunClaimed(heartbeat, run!.id);
    const queuedSiblingId = await seedQueuedSiblingRun(db, { companyId, agentId });
    gate.release();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe(IDENTICAL_FAILURE_TEST_ERROR_CODE);

    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0]?.status ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toBe("paused");

    const pausedAgent = await db
      .select({ pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(pausedAgent?.pauseReason).toContain(IDENTICAL_FAILURE_TEST_ERROR_CODE);
    expect(pausedAgent?.pauseReason).toContain("then resume");

    await expectSiblingCancelledAsPaused(db, queuedSiblingId);
  });

  // A transient recovery contract used to take the bounded-retry branch and
  // return before the identical-failure storm breaker was ever evaluated. The
  // bounded retry caps attempts inside ONE chain, but each heartbeat opens a
  // fresh chain, so a permanent misconfiguration that merely looks transient
  // looped failed runs forever (521 in 48 hours for one real company).
  async function runTransientStormAgent(input: {
    companyId: string;
    agentId: string;
    priorFailures: number;
    priorErrorCode?: string;
    exhaustBudget: boolean;
  }) {
    await seedIdenticalFailureFixture({
      companyId: input.companyId,
      agentId: input.agentId,
      adapterType: TRANSIENT_STORM_TEST_ADAPTER,
      priorRuns: Array.from({ length: input.priorFailures }, () => ({
        status: "failed" as const,
        errorCode: input.priorErrorCode ?? TRANSIENT_STORM_TEST_ERROR_CODE,
      })),
    });

    const gate = createGate();
    transientStormGate = gate.promise;

    const run = await heartbeat.invoke(input.agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    await waitForRunClaimed(heartbeat, run!.id);

    if (input.exhaustBudget) {
      // The adapter caps the budget at 1 attempt, so a run already carrying
      // attempt 1 has nothing left: nextAttempt (2) > maxAttempts (1).
      await db
        .update(heartbeatRuns)
        .set({ scheduledRetryAttempt: 1 })
        .where(eq(heartbeatRuns.id, run!.id));
    }
    gate.release();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe(TRANSIENT_STORM_TEST_ERROR_CODE);
    return run!.id;
  }

  async function agentStatus(agentId: string) {
    return db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  it("pauses an agent whose exhausted transient retries keep failing the same way", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await runTransientStormAgent({
      companyId,
      agentId,
      priorFailures: CONSECUTIVE_IDENTICAL_FAILURE_PAUSE_THRESHOLD - 1,
      exhaustBudget: true,
    });

    await expect
      .poll(() => agentStatus(agentId).then((row) => row?.status ?? null), {
        timeout: 5_000,
        interval: 50,
      })
      .toBe("paused");

    const paused = await agentStatus(agentId);
    expect(paused?.pauseReason).toContain(TRANSIENT_STORM_TEST_ERROR_CODE);
  });

  it("keeps retrying while the transient budget still has attempts left", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await runTransientStormAgent({
      companyId,
      agentId,
      priorFailures: CONSECUTIVE_IDENTICAL_FAILURE_PAUSE_THRESHOLD - 1,
      exhaustBudget: false,
    });

    // Give the breaker the same window the passing case needs before asserting
    // the absence of a pause.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await agentStatus(agentId))?.status).not.toBe("paused");
  });

  it("does not pause when the exhausted failures carry different error codes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await runTransientStormAgent({
      companyId,
      agentId,
      priorFailures: CONSECUTIVE_IDENTICAL_FAILURE_PAUSE_THRESHOLD - 1,
      priorErrorCode: "some_other_error",
      exhaustBudget: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await agentStatus(agentId))?.status).not.toBe("paused");
  });

  it("pauses an agent whose run throws a non-retryable adapter setup failure instead of re-running it", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Unrunnable Adapter Agent",
      role: "engineer",
      status: "idle",
      adapterType: SETUP_FAILURE_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    // The real non-retryable-setup-failure trigger (isNonRetryableAdapterSetupFailure)
    // fires when environment lease acquisition throws "... is not in the
    // configured adapter registry" BEFORE the adapter ever dispatches (e.g. a k8s
    // sandbox provider rejecting an adapter type). Reproduce that exact shape by
    // wrapping the real environment runtime's acquireRunLease and injecting the
    // failure only for this test's adapter type; every other call (and every
    // other test's heartbeat instance) is untouched.
    const gate = createGate();
    setupFailureGate = gate.promise;
    const realEnvironmentRuntime = environmentRuntimeService(db);
    const setupFailureHeartbeat = heartbeatService(db, {
      environmentRuntime: {
        ...realEnvironmentRuntime,
        acquireRunLease: async (input) => {
          if (input.adapterType === SETUP_FAILURE_TEST_ADAPTER) {
            if (setupFailureGate) await setupFailureGate;
            throw new Error(`Adapter "${input.adapterType}" is not in the configured adapter registry`);
          }
          return realEnvironmentRuntime.acquireRunLease(input);
        },
      },
    });

    const run = await setupFailureHeartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    await waitForRunClaimed(setupFailureHeartbeat, run!.id);
    const queuedSiblingId = await seedQueuedSiblingRun(db, { companyId, agentId });
    gate.release();

    const failedRun = await waitForRunToFinish(setupFailureHeartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("setup_failed");

    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0]?.status ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toBe("paused");

    const pausedAgent = await db
      .select({ pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(pausedAgent?.pauseReason).toContain("non-retryable setup failure");
    expect(pausedAgent?.pauseReason).toContain("Reconfigure the agent's adapter/runtime");

    await expectSiblingCancelledAsPaused(db, queuedSiblingId);
    await setupFailureHeartbeat.drain();
  });

  it("does not pause an agent whose identical-failure streak is below the threshold", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedIdenticalFailureFixture({
      companyId,
      agentId,
      priorRuns: Array.from(
        { length: CONSECUTIVE_IDENTICAL_FAILURE_PAUSE_THRESHOLD - 2 },
        () => ({ status: "failed" as const }),
      ),
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");

    // Give the finalize pipeline time to (wrongly) pause before asserting.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const agentStatus = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]?.status ?? null);
    expect(agentStatus).not.toBe("paused");
  });

  it("does not pause an agent when a success or a different error code breaks the streak", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedIdenticalFailureFixture({
      companyId,
      agentId,
      priorRuns: [
        { status: "failed" },
        { status: "failed" },
        { status: "succeeded" },
        { status: "failed" },
        { status: "failed", errorCode: "some_other_code" },
      ],
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");

    await new Promise((resolve) => setTimeout(resolve, 700));
    const agentStatus = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]?.status ?? null);
    expect(agentStatus).not.toBe("paused");
  });

  async function seedMaxTurnFixture(input?: {
    companyId?: string;
    agentId?: string;
    issueId?: string;
    runId?: string;
    now?: Date;
    scheduledRetryAttempt?: number;
    runtimeConfig?: Record<string, unknown>;
    issueStatus?: string;
  }) {
    const companyId = input?.companyId ?? randomUUID();
    const agentId = input?.agentId ?? randomUUID();
    const issueId = input?.issueId ?? randomUUID();
    const runId = input?.runId ?? randomUUID();
    const now = input?.now ?? new Date("2026-04-20T12:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: input?.runtimeConfig ?? {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 2,
            delayMs: 1_000,
          },
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "Maximum turns reached",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      scheduledRetryAttempt: input?.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input?.scheduledRetryAttempt ? MAX_TURN_CONTINUATION_RETRY_REASON : null,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        stopReason: "max_turns_exhausted",
      },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue after max turns",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, runId, now };
  }

  it("bounds interrupted conversations across restarts and concurrent scheduling", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture();
    const resultJson = { conversationContinuation: "continue_conversation_v1" };
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "server_shutdown_interrupted", resultJson })
      .where(eq(heartbeatRuns.id, runId));
    let predecessor = runId;
    for (const attempt of [1, 2]) {
      const restarted = heartbeatService(db);
      const outcomes = await Promise.all([
        restarted.scheduleBoundedRetry(predecessor, { now, random: () => 0 }),
        restarted.scheduleBoundedRetry(predecessor, { now, random: () => 0 }),
      ]);
      expect(outcomes.every(outcome => outcome.outcome === "scheduled")).toBe(true);
      const children = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, predecessor));
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ scheduledRetryAttempt: attempt });
      predecessor = children[0]!.id;
      await db.update(heartbeatRuns).set({ status: "interrupted", finishedAt: now, resultJson })
        .where(eq(heartbeatRuns.id, predecessor));
    }
    expect(await heartbeatService(db).scheduleBoundedRetry(predecessor, { now }))
      .toMatchObject({ outcome: "retry_exhausted" });
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(3);
    // Exhaustion leaves the task available to a new explicit request.
    const { getExecutionBlocker } = await import("../services/execution-blocker.js");
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
  });

  it.each(["dependency", "disabled", "reassigned"])("respects the %s gate for interrupted conversations", async gate => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture();
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "process_lost",
      resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, runId));
    if (gate === "dependency") {
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId, title: "Required work", status: "todo" });
      await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    } else if (gate === "disabled") {
      await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, agentId));
    } else {
      await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
    }
    expect(await heartbeat.scheduleBoundedRetry(runId, { now })).toMatchObject({ outcome: "not_scheduled" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
  });

  it.each([
    ["interaction", false], ["approval", false], ["interaction", true], ["approval", true],
  ] as const)("waits for a pending %s before continuing (already scheduled: %s)", async (kind, alreadyScheduled) => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture();
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "process_lost",
      resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, runId));
    let retryRunId = runId;
    if (alreadyScheduled) {
      const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") throw new Error("Expected a retry");
      retryRunId = scheduled.run.id;
    }
    if (kind === "interaction") {
      await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions",
        status: "pending", payload: { version: 1, questions: [] } });
    } else {
      const approvalId = randomUUID();
      await db.insert(approvals).values({ id: approvalId, companyId, type: "hire_agent", status: "pending", payload: {} });
      await db.insert(issueApprovals).values({ companyId, issueId, approvalId });
    }
    if (alreadyScheduled) {
      const adapter = createPostgresRunDispatchAdapter(db);
      expect(await adapter.promoteOrCancelDueRetry({ companyId, runId: retryRunId, now: new Date(now.getTime() + 60_000) }))
        .toMatchObject({ outcome: "gate_suppressed", errorCode: "issue_waiting_for_response" });
      const stopped = await heartbeat.getRun(retryRunId);
      expect(stopped?.status).toBe("cancelled");
      const { legacyExecutionNeedsReconciliation } = await import("../services/legacy-execution-recovery.js");
      expect(legacyExecutionNeedsReconciliation(stopped!)).toBe(false);
    } else {
      expect(await heartbeat.scheduleBoundedRetry(runId, { now }))
        .toMatchObject({ outcome: "not_scheduled", errorCode: "issue_waiting_for_response" });
    }
  });

  it("schedules a retry with durable metadata and only promotes it when due", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const expectedDueAt = new Date(now.getTime() + BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0]);
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(expectedDueAt.toISOString());

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(expectedDueAt.toISOString());

    const earlyPromotion = await heartbeat.promoteDueScheduledRetries(new Date(expectedDueAt.getTime() - 1));
    expect(earlyPromotion).toEqual({ promoted: 0, runIds: [] });

    const stillScheduled = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(stillScheduled?.status).toBe("scheduled_retry");

    const duePromotion = await heartbeat.promoteDueScheduledRetries(expectedDueAt);
    expect(duePromotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const promotedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun?.status).toBe("queued");
  });

  it("schedules max-turn continuations with distinct retry metadata", async () => {
    const { runId, now } = await seedMaxTurnFixture();

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(new Date(now.getTime() + 1_000).toISOString());

    const retryRun = await db
      .select({
        retryOfRunId: heartbeatRuns.retryOfRunId,
        status: heartbeatRuns.status,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
    });
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.wakeReason).toBe(
      MAX_TURN_CONTINUATION_WAKE_REASON,
    );
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wakeupRequest?.reason).toBe(MAX_TURN_CONTINUATION_WAKE_REASON);
    expect(wakeupRequest?.payload).toMatchObject({
      retryOfRunId: runId,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });
  });

  it("schedules accepted interaction continuation infra retries while the issue is in_review", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const interactionId = randomUUID();

    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.maxAttempts).toBe(3);

    const retryRun = await db
      .select({
        retryOfRunId: heartbeatRuns.retryOfRunId,
        status: heartbeatRuns.status,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
    });
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      interactionId,
      interactionStatus: "accepted",
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      scheduledRetryAttempt: 1,
    });

    const wakeupRequest = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wakeupRequest?.reason).toBe(INTERACTION_CONTINUATION_INFRA_WAKE_REASON);
    expect(wakeupRequest?.payload).toMatchObject({
      issueId,
      interactionId,
      retryOfRunId: runId,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(scheduled.run.id);
  });

  it("coalesces duplicate accepted interaction continuation infra retry schedules", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const retryOptions = {
      now,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    };
    const [first, second] = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
    ]);

    expect(first.outcome).toBe("scheduled");
    expect(second.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled" || second.outcome !== "scheduled") return;
    expect(new Set([first.run.id, second.run.id]).size).toBe(1);

    const retryRuns = await db
      .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.retryOfRunId, runId),
        eq(heartbeatRuns.scheduledRetryReason, INTERACTION_CONTINUATION_INFRA_RETRY_REASON),
        eq(heartbeatRuns.scheduledRetryAttempt, 1),
      ));
    expect(retryRuns).toHaveLength(1);

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        coalescedCount: agentWakeupRequests.coalescedCount,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, INTERACTION_CONTINUATION_INFRA_WAKE_REASON));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      id: retryRuns[0]?.wakeupRequestId,
      coalescedCount: 1,
    });
    expect(wakeups[0]?.idempotencyKey).toContain(`:${issueId}:${runId}:1`);
  });

  it.each([
    {
      name: "renamed branch",
      workspaceValidation: (workspaceId: string) => ({
        reason: "git_worktree_branch_incoherence",
        fingerprint: "workspace_incoherence:v1:sha256:renamed",
        executionWorkspaceId: workspaceId,
        expectedBranch: "stale-plan-approval-workspace",
        actualBranch: "feat/skill-studio-test-runs",
        cleanliness: "clean",
      }),
    },
    {
      name: "dirty worktree",
      workspaceValidation: (workspaceId: string) => ({
        reason: "git_worktree_branch_incoherence",
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        executionWorkspaceId: workspaceId,
        expectedBranch: "stale-plan-approval-workspace",
        actualBranch: "feat/skill-studio-test-runs",
        cleanliness: "dirty",
        safeRepair: {
          eligible: false,
          attempted: false,
          succeeded: false,
          reason: "worktree is not clean",
        },
      }),
    },
  ])("quarantines a failed $name workspace before scheduling the accepted interaction retry", async ({ workspaceValidation }) => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const validation = workspaceValidation(executionWorkspaceId);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "stale-plan-approval-workspace",
      status: "active",
      cwd: "/workspace/stale-plan-approval-workspace",
      baseRef: "origin/master",
      branchName: "stale-plan-approval-workspace",
      providerType: "git_worktree",
      providerRef: "/workspace/stale-plan-approval-workspace",
      metadata: { existing: true },
    });
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const workspace = await db
      .select({
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
        cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
        cleanupReason: executionWorkspaces.cleanupReason,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    expect(workspace).toMatchObject({
      status: "archived",
      cleanupEligibleAt: null,
      cleanupReason: "workspace_validation_failed",
    });
    expect(workspace?.closedAt?.toISOString()).toBe(now.toISOString());
    expect(workspace?.metadata).toMatchObject({
      existing: true,
      workspaceValidationQuarantine: {
        reason: "workspace_validation_failed",
        retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
        sourceRunId: runId,
        retryRunId: scheduled.run.id,
        issueId,
        sourceIssueId: issueId,
        workspaceValidation: validation,
      },
    });

    const retryRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.contextSnapshot).toMatchObject({
      workspaceValidationRecovery: {
        strategy: "quarantine_failed_workspace_and_retry_clean",
        sourceRunId: runId,
        reason: "git_worktree_branch_incoherence",
        fingerprint: validation.fingerprint,
        failedExecutionWorkspaceId: executionWorkspaceId,
      },
    });

    const activity = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ))
      .then((rows) => rows[0] ?? null);
    expect(activity).toMatchObject({
      action: "execution_workspace.workspace_validation_quarantined",
      entityId: executionWorkspaceId,
      details: expect.objectContaining({
        retryRunId: scheduled.run.id,
        workspaceValidation: validation,
      }),
    });

    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.id).toBe(agentId);
  });

  it("does not quarantine another issue's workspace when validation payload is stale", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const currentWorkspaceId = randomUUID();
    const foreignIssueId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const validation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: "workspace_incoherence:v1:sha256:stale",
      executionWorkspaceId: foreignWorkspaceId,
      expectedBranch: "current-issue-branch",
      actualBranch: "foreign-issue-branch",
      cleanliness: "clean",
    };

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId,
      title: "Other active issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(executionWorkspaces).values([
      {
        id: currentWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "current-issue-branch",
        status: "active",
        cwd: "/workspace/current-issue-branch",
        baseRef: "origin/master",
        branchName: "current-issue-branch",
        providerType: "git_worktree",
        providerRef: "/workspace/current-issue-branch",
        metadata: { current: true },
      },
      {
        id: foreignWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: foreignIssueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "foreign-issue-branch",
        status: "active",
        cwd: "/workspace/foreign-issue-branch",
        baseRef: "origin/master",
        branchName: "foreign-issue-branch",
        providerType: "git_worktree",
        providerRef: "/workspace/foreign-issue-branch",
        metadata: { foreign: true },
      },
    ]);
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId: foreignWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: foreignWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });

    const workspaces = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [currentWorkspaceId, foreignWorkspaceId]));
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: currentWorkspaceId, status: "active", metadata: { current: true } }),
      expect.objectContaining({ id: foreignWorkspaceId, status: "active", metadata: { foreign: true } }),
    ]));

    const activity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ));
    expect(activity).toHaveLength(0);
  });

  it("does not quarantine an owned workspace that is no longer attached to the issue", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const staleWorkspaceId = randomUUID();
    const currentWorkspaceId = randomUUID();
    const validation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: "workspace_incoherence:v1:sha256:stale-owned",
      executionWorkspaceId: staleWorkspaceId,
      expectedBranch: "old-plan-approval-workspace",
      actualBranch: "current-plan-approval-workspace",
      cleanliness: "clean",
    };

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values([
      {
        id: staleWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "old-plan-approval-workspace",
        status: "active",
        cwd: "/workspace/old-plan-approval-workspace",
        baseRef: "origin/master",
        branchName: "old-plan-approval-workspace",
        providerType: "git_worktree",
        providerRef: "/workspace/old-plan-approval-workspace",
        metadata: { stale: true },
      },
      {
        id: currentWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "current-plan-approval-workspace",
        status: "active",
        cwd: "/workspace/current-plan-approval-workspace",
        baseRef: "origin/master",
        branchName: "current-plan-approval-workspace",
        providerType: "git_worktree",
        providerRef: "/workspace/current-plan-approval-workspace",
        metadata: { current: true },
      },
    ]);
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId: currentWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: currentWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });

    const workspaces = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [staleWorkspaceId, currentWorkspaceId]));
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: staleWorkspaceId, status: "active", metadata: { stale: true } }),
      expect.objectContaining({ id: currentWorkspaceId, status: "active", metadata: { current: true } }),
    ]));

    const activity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ));
    expect(activity).toHaveLength(0);
  });

  it("does not schedule accepted interaction continuation infra retries after terminal issue status", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "done" });

    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId: randomUUID(),
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "issue_terminal_status",
      issueId,
    });
  });

  it("coalesces duplicate max-turn continuation schedules for the same source run and attempt", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture();
    const retryOptions = {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    };

    const [first, second] = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
    ]);

    expect(first.outcome).toBe("scheduled");
    expect(second.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled" || second.outcome !== "scheduled") return;

    expect(new Set([first.run.id, second.run.id]).size).toBe(1);

    const retryRuns = await db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.retryOfRunId, runId),
          eq(heartbeatRuns.scheduledRetryReason, MAX_TURN_CONTINUATION_RETRY_REASON),
          eq(heartbeatRuns.scheduledRetryAttempt, 1),
        ),
      );
    expect(retryRuns).toHaveLength(1);

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        coalescedCount: agentWakeupRequests.coalescedCount,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, MAX_TURN_CONTINUATION_WAKE_REASON));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      id: retryRuns[0]?.wakeupRequestId,
      coalescedCount: 1,
    });
    expect(wakeups[0]?.idempotencyKey).toContain(`:${issueId}:${runId}:1`);

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRuns[0]?.id);
  });

  it("does not promote a duplicate max-turn continuation that does not own the issue lock", async () => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture();

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const duplicateWakeupId = randomUUID();
    const duplicateRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: duplicateWakeupId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: MAX_TURN_CONTINUATION_WAKE_REASON,
      payload: {
        issueId,
        retryOfRunId: runId,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        scheduledRetryAttempt: 1,
      },
      status: "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: duplicateRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId: duplicateWakeupId,
      retryOfRunId: runId,
      scheduledRetryAt: scheduled.dueAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: duplicateRunId })
      .where(eq(agentWakeupRequests.id, duplicateWakeupId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const duplicate = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, duplicateRunId))
      .then((rows) => rows[0] ?? null);
    expect(duplicate).toEqual({
      status: "cancelled",
      errorCode: "issue_execution_lock_changed",
    });

    const duplicateWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, duplicateWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(duplicateWakeup?.status).toBe("cancelled");
  });

  it.each(["blocked", "todo", "backlog"] as const)(
    "cancels a due max-turn continuation when the issue moves to %s before retry promotion",
    async (issueStatus) => {
      const { issueId, runId, now } = await seedMaxTurnFixture();

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        maxAttempts: 2,
        delayMs: 1_000,
      });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;

      await db.update(issues).set({
        status: issueStatus,
        updatedAt: new Date(now.getTime() + 500),
      }).where(eq(issues.id, issueId));

      const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
      expect(promotion).toEqual({ promoted: 0, runIds: [] });

      const retryRun = await db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect(retryRun).toMatchObject({
        status: "cancelled",
        errorCode: "issue_not_in_progress",
      });

      const wakeupRequest = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect(wakeupRequest?.status).toBe("cancelled");

      const issue = await db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue).toEqual({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      });

      const event = await db
        .select({
          message: heartbeatRunEvents.message,
          payload: heartbeatRunEvents.payload,
        })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, scheduled.run.id))
        .orderBy(sql`${heartbeatRunEvents.seq} desc`)
        .then((rows) => rows[0] ?? null);
      expect(event?.message).toContain("no longer in_progress");
      expect(event?.payload).toMatchObject({
        currentStatus: issueStatus,
        requiredStatus: "in_progress",
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      });
    },
  );

  it("does not defer a new assignee behind the previous assignee's scheduled retry", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T13:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry reassignment",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    // Keep the new agent's queue from auto-claiming/executing during this unit test.
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        companyId,
        agentId: newAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {
          wakeReason: "test_busy_slot",
        },
        startedAt: now,
        updatedAt: now,
        createdAt: now,
      })),
    );

    const newAssigneeRun = await heartbeat.wakeup(newAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {
        issueId,
        mutation: "update",
      },
      contextSnapshot: {
        issueId,
        source: "issue.update",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(newAgentId);
    expect(newAssigneeRun?.status).toBe("queued");

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const deferredWakeups = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(deferredWakeups).toBe(0);

    // The stale-retry cancel runs inside enqueueWakeup's transaction, and
    // the run's own required lifecycle work never awaits the telemetry
    // emission, so wait for it here instead of asserting it fired
    // synchronously.
    await vi.waitFor(() => {
      expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(
        mockTelemetryClient,
        expect.objectContaining({
          agentId: oldAgentId,
          state: "cancelled",
        }),
      );
    });
  });

  it("exhausts bounded retries after the hard cap", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const cappedRunId = randomUUID();
    const now = new Date("2026-04-20T18:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: cappedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      error: "still transient",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        wakeReason: "transient_failure_retry",
      },
      updatedAt: now,
      createdAt: now,
    });

    const exhausted = await heartbeat.scheduleBoundedRetry(cappedRunId, {
      now,
      random: () => 0.5,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length + 1,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(1);

    const exhaustionEvent = await db
      .select({
        message: heartbeatRunEvents.message,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, cappedRunId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows[0] ?? null);

    expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
    expect(exhaustionEvent?.payload).toMatchObject({
      retryReason: "transient_failure",
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });
  });

  it("honors an adapter-supplied transientRetryMaxAttempts cap tighter than the default", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");

    // Within the per-run cap of 2: nextAttempt (2) <= cap (2) -> still schedules.
    const withinCapRunId = randomUUID();
    await seedRetryFixture({
      runId: withinCapRunId,
      companyId,
      agentId,
      now,
      errorCode: "inference_model_unavailable",
      scheduledRetryAttempt: 1,
      resultJson: { errorFamily: "transient_upstream", transientRetryMaxAttempts: 2 },
    });

    const withinCap = await heartbeat.scheduleBoundedRetry(withinCapRunId, {
      now,
      random: () => 0.5,
    });
    expect(withinCap.outcome).toBe("scheduled");

    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);

    // Past the per-run cap of 2: nextAttempt (3) > cap (2) -> exhausted now,
    // even though the default bounded backoff would still allow attempt 3.
    const pastCapRunId = randomUUID();
    await seedRetryFixture({
      runId: pastCapRunId,
      companyId,
      agentId,
      now,
      errorCode: "inference_model_unavailable",
      scheduledRetryAttempt: 2,
      resultJson: { errorFamily: "transient_upstream", transientRetryMaxAttempts: 2 },
    });

    const pastCap = await heartbeat.scheduleBoundedRetry(pastCapRunId, {
      now,
      random: () => 0.5,
    });
    expect(pastCap).toEqual({
      outcome: "retry_exhausted",
      attempt: 3,
      maxAttempts: 2,
    });
  });

  it("advances codex transient fallback stages across bounded retry attempts", async () => {
    const fallbackModes = [
      "same_session",
      "safer_invocation",
    ] as const;

    for (const [index, expectedMode] of fallbackModes.entries()) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const now = new Date(`2026-04-20T1${index}:00:00.000Z`);

      await seedRetryFixture({
        runId,
        companyId,
        agentId,
        now,
        errorCode: "adapter_failed",
        errorFamily: "transient_upstream",
        scheduledRetryAttempt: index,
      });

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        random: () => 0.5,
      });

      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") continue;

      const retryRun = await db
        .select({
          contextSnapshot: heartbeatRuns.contextSnapshot,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      const wakeupRequest = await db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect((wakeupRequest?.payload as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      await cleanupRetryFixture();
    }
  });

  it("requires reconciliation for a classified Codex harness crash", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-07-24T12:00:00.000Z");

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "codex_harness_crash",
      errorFamily: "transient_upstream",
    });

    await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled).toMatchObject({ outcome: "not_scheduled", errorCode: "legacy_execution_requires_reconciliation" });

    await cleanupRetryFixture();
  });

  it("requires reconciliation for an error-code-only Codex harness crash", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-07-24T13:00:00.000Z");

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "codex_harness_crash",
      errorFamily: null,
    });

    await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled).toMatchObject({ outcome: "not_scheduled", errorCode: "legacy_execution_requires_reconciliation" });

    await cleanupRetryFixture();
  });

  it("honors codex retry-not-before timestamps when they exceed the default bounded backoff", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 22, 29, 0);
    const retryNotBefore = new Date(2026, 3, 22, 23, 31, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });

  it("schedules bounded retries for claude_transient_upstream and honors its retry-not-before hint", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 10, 0, 0);
    const retryNotBefore = new Date(2026, 3, 22, 16, 0, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      adapterType: "claude_local",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    const contextSnapshot = (retryRun?.contextSnapshot as Record<string, unknown> | null) ?? {};
    expect(contextSnapshot.transientRetryNotBefore).toBe(retryNotBefore.toISOString());
    // Claude does not participate in the Codex fallback-mode ladder.
    expect(contextSnapshot.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });

  describe("run-dispatch module transactions", () => {
    it("promotes a due scheduled retry exactly once under concurrent promotion attempts", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId = randomUUID();
      const now = new Date("2026-05-01T00:00:00.000Z");

      await seedRetryFixture({ runId: sourceRunId, companyId, agentId, now, errorCode: "adapter_failed" });
      const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, { now, random: () => 0.5 });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;

      const [first, second] = await Promise.all([
        heartbeat.promoteDueScheduledRetries(scheduled.dueAt),
        heartbeat.promoteDueScheduledRetries(scheduled.dueAt),
      ]);

      expect(first.promoted + second.promoted).toBe(1);
      const [row] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id));
      expect(row?.status).toBe("queued");
    });

    it("rolls back the run-status update when the run-event write fails during promotion", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId = randomUUID();
      const now = new Date("2026-05-02T00:00:00.000Z");

      await seedRetryFixture({ runId: sourceRunId, companyId, agentId, now, errorCode: "adapter_failed" });
      const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, { now, random: () => 0.5 });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;

      mockedAppendHeartbeatRunEvent.mockRejectedValueOnce(new Error("injected promotion event fault"));

      await expect(heartbeat.promoteDueScheduledRetries(scheduled.dueAt)).rejects.toThrow(
        "injected promotion event fault",
      );

      const [row] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id));
      expect(row?.status).toBe("scheduled_retry");
    });

    it("rolls back the wakeup-request update when the run-event write fails during a gate-suppressed cancellation", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId = randomUUID();
      const missingIssueId = randomUUID();
      const now = new Date("2026-05-03T00:00:00.000Z");

      await seedRetryFixture({ runId: sourceRunId, companyId, agentId, now, errorCode: "adapter_failed" });

      const wakeupRequestId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "retry",
        status: "queued",
      });

      // A max-turn continuation whose issue no longer exists trips the gate's
      // "issue_not_found" rejection without the legacy transient-retry
      // exception, so promotion routes it to the cancel-suppressed-retry write.
      const retryRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: retryRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        status: "scheduled_retry",
        scheduledRetryAt: now,
        scheduledRetryAttempt: 1,
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeupRequestId,
        contextSnapshot: { issueId: missingIssueId, wakeReason: "issue_continuation_needed" },
        updatedAt: now,
        createdAt: now,
      });

      mockedAppendHeartbeatRunEvent.mockRejectedValueOnce(new Error("injected cancellation event fault"));

      await expect(heartbeat.promoteDueScheduledRetries(now)).rejects.toThrow(
        "injected cancellation event fault",
      );

      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, retryRunId));
      expect(run?.status).toBe("scheduled_retry");

      const [wake] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId));
      expect(wake?.status).toBe("queued");
    });

    it("keeps promotion and stale-queued-run cancellation company-scoped", async () => {
      const adapter = createPostgresRunDispatchAdapter(db);
      const companyId = randomUUID();
      const otherCompanyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const now = new Date("2026-05-04T00:00:00.000Z");

      await seedRetryFixture({ runId, companyId, agentId, now, errorCode: "adapter_failed" });
      await db
        .update(heartbeatRuns)
        .set({ status: "scheduled_retry", scheduledRetryAt: now })
        .where(eq(heartbeatRuns.id, runId));

      const wrongCompanyPromotion = await adapter.promoteOrCancelDueRetry({
        runId,
        companyId: otherCompanyId,
        now,
      });
      expect(wrongCompanyPromotion).toEqual({ outcome: "not_promoted" });
      const [afterWrongCompanyPromotion] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(afterWrongCompanyPromotion?.status).toBe("scheduled_retry");

      const rightCompanyPromotion = await adapter.promoteOrCancelDueRetry({ runId, companyId, now });
      expect(rightCompanyPromotion.outcome).toBe("promoted");

      const issueId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Stale queued run target",
        status: "cancelled",
        priority: "medium",
        responsibleUserId: "responsible-user",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      });
      const queuedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: queuedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "queued",
        contextSnapshot: { issueId },
        updatedAt: now,
        createdAt: now,
      });

      await expect(
        adapter.cancelStaleQueuedRun({
          runId: queuedRunId,
          companyId: otherCompanyId,
          expectedStatus: "queued",
          now,
        }),
      ).rejects.toThrow();
      const [afterWrongCompanyCancel] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRunId));
      expect(afterWrongCompanyCancel?.status).toBe("queued");

      const lostRaceCancel = await adapter.cancelStaleQueuedRun({
        runId: queuedRunId,
        companyId,
        expectedStatus: "running",
        now,
      });
      expect(lostRaceCancel).toEqual({ outcome: "lost_race" });
      const [afterLostRaceCancel] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRunId));
      expect(afterLostRaceCancel?.status).toBe("queued");

      const rightCompanyCancel = await adapter.cancelStaleQueuedRun({
        runId: queuedRunId,
        companyId,
        expectedStatus: "queued",
        now,
      });
      expect(rightCompanyCancel.outcome).toBe("cancelled");
    });

    it("never writes another company's wakeup request during suppressed-retry or stale-queued-run cancellation", async () => {
      const adapter = createPostgresRunDispatchAdapter(db);
      const companyId = randomUUID();
      const otherCompanyId = randomUUID();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      const now = new Date("2026-05-05T00:00:00.000Z");

      await seedRetryFixture({ runId: randomUUID(), companyId, agentId, now, errorCode: "adapter_failed" });
      await db.insert(companies).values({
        id: otherCompanyId,
        name: "Other Co",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      // Each wakeup request belongs to `otherCompanyId`, standing in for a
      // mismatched cross-company reference on the run — the scenario the
      // company predicate on the wakeup write must guard against.
      const suppressedWakeupId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: suppressedWakeupId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        source: "retry",
        status: "queued",
      });
      const suppressedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: suppressedRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        status: "scheduled_retry",
        scheduledRetryAt: now,
        wakeupRequestId: suppressedWakeupId,
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        contextSnapshot: { issueId: randomUUID() },
        updatedAt: now,
        createdAt: now,
      });

      const suppressedCancel = await adapter.promoteOrCancelDueRetry({
        runId: suppressedRunId,
        companyId,
        now,
      });
      expect(suppressedCancel.outcome).toBe("gate_suppressed");

      const [suppressedWakeup] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, suppressedWakeupId));
      expect(suppressedWakeup?.status).toBe("queued");

      const staleWakeupId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: staleWakeupId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        source: "assignment",
        status: "queued",
      });
      const staleIssueId = randomUUID();
      const staleIssuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      await db.insert(issues).values({
        id: staleIssueId,
        companyId,
        title: "Stale queued run target",
        status: "cancelled",
        priority: "medium",
        responsibleUserId: "responsible-user",
        issueNumber: 3,
        identifier: `${staleIssuePrefix}-3`,
      });
      const staleRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: staleRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "queued",
        wakeupRequestId: staleWakeupId,
        contextSnapshot: { issueId: staleIssueId },
        updatedAt: now,
        createdAt: now,
      });

      const staleCancel = await adapter.cancelStaleQueuedRun({
        runId: staleRunId,
        companyId,
        expectedStatus: "queued",
        now,
      });
      expect(staleCancel.outcome).toBe("cancelled");

      const [staleWakeup] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, staleWakeupId));
      expect(staleWakeup?.status).toBe("queued");
    });

    it("orders due retries by due time, honors the cutoff, and caps a sweep at 50 runs", async () => {
      const adapter = createPostgresRunDispatchAdapter(db);
      const companyId = randomUUID();
      const agentId = randomUUID();
      const now = new Date("2026-05-05T00:00:00.000Z");
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      // Due, but created well before the cutoff: the cutoff must exclude it
      // even though it is the single most-overdue run in the table.
      const beforeCutoffRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: beforeCutoffRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        status: "scheduled_retry",
        scheduledRetryAt: new Date(now.getTime() - 1_000),
        contextSnapshot: {},
        createdAt: new Date(now.getTime() - 1_000_000),
        updatedAt: now,
      });

      // 52 due, in-cutoff runs, strictly ordered by scheduledRetryAt/createdAt.
      const dueRunIds = Array.from({ length: 52 }, () => randomUUID());
      for (let i = 0; i < dueRunIds.length; i += 1) {
        const dueAt = new Date(now.getTime() - (dueRunIds.length - i) * 1_000);
        await db.insert(heartbeatRuns).values({
          id: dueRunIds[i],
          companyId,
          agentId,
          invocationSource: "retry",
          status: "scheduled_retry",
          scheduledRetryAt: dueAt,
          contextSnapshot: {},
          createdAt: dueAt,
          updatedAt: now,
        });
      }

      const cutoff = new Date(now.getTime() - 500_000);
      const result = await adapter.listDueRetries({ now, cutoff, limit: 50 });

      expect(result).toHaveLength(50);
      expect(result.map((r) => r.runId)).toEqual(dueRunIds.slice(0, 50));
      const resultIds = new Set(result.map((r) => r.runId));
      expect(resultIds.has(beforeCutoffRunId)).toBe(false);
      expect(resultIds.has(dueRunIds[50])).toBe(false);
      expect(resultIds.has(dueRunIds[51])).toBe(false);
    });
  });
});
