import { describe, expect, it, vi } from "vitest";
import {
  createDrizzleActivationStore,
  hasActivationForCompany,
  recordActivationEvent,
  resolveActivationSink,
} from "./activation.js";

describe("resolveActivationSink", () => {
  it("returns null when PAPERCLIP_ACTIVATION_SINK is unset", () => {
    expect(resolveActivationSink({})).toBeNull();
  });

  it("returns 'db' when configured", () => {
    expect(resolveActivationSink({ PAPERCLIP_ACTIVATION_SINK: "db" })).toBe(
      "db",
    );
  });

  it("ignores unknown sink values", () => {
    expect(
      resolveActivationSink({ PAPERCLIP_ACTIVATION_SINK: "posthog" }),
    ).toBeNull();
  });
});

describe("recordActivationEvent", () => {
  function makeDb(priorCount: number) {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      countActivationForCompany: vi.fn(async () => priorCount),
      insertActivationEvent: vi.fn(async (row: Record<string, unknown>) => {
        inserted.push(row);
      }),
    };
    return { db, inserted };
  }

  it("is a no-op when no sink is configured", async () => {
    const { db, inserted } = makeDb(0);
    await recordActivationEvent(db as never, {
      companyId: "c1",
      agentId: "a1",
      heartbeatRunId: "r1",
      sink: null,
      runStatus: "succeeded",
    });
    expect(db.insertActivationEvent).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("writes firstForCompany=true on the company's first successful run", async () => {
    const { db, inserted } = makeDb(0);
    await recordActivationEvent(db as never, {
      companyId: "c1",
      agentId: "a1",
      heartbeatRunId: "r1",
      sink: "db",
      runStatus: "succeeded",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      companyId: "c1",
      agentId: "a1",
      heartbeatRunId: "r1",
      eventType: "first_successful_run",
      firstForCompany: true,
    });
  });

  it("writes firstForCompany=false when a prior activation exists", async () => {
    const { db, inserted } = makeDb(3);
    await recordActivationEvent(db as never, {
      companyId: "c1",
      agentId: "a1",
      heartbeatRunId: "r1",
      sink: "db",
      runStatus: "succeeded",
    });
    expect(inserted[0]).toMatchObject({ firstForCompany: false });
  });

  // The event this table records is literally called `first_successful_run`,
  // and every consumer (admin-console journeys/cohortFunnel/signupFeed) reads
  // MIN(occurred_at) with no join back to the run. A run that failed but still
  // burned tokens must therefore never land here: in prod this counted 3 of 48
  // companies as activated off `adapter_failed` / `inference_auth_invalid` /
  // `inference_model_unavailable` runs.
  it.each(["failed", "cancelled", "timed_out", "interrupted", "running", "queued"])(
    "does not write activation for a %s run even when it burned tokens",
    async (runStatus) => {
      const { db, inserted } = makeDb(0);
      await recordActivationEvent(db as never, {
        companyId: "c1",
        agentId: "a1",
        heartbeatRunId: "r1",
        sink: "db",
        runStatus,
      });
      expect(db.insertActivationEvent).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(0);
    },
  );

  it("writes activation for a succeeded run", async () => {
    const { db, inserted } = makeDb(0);
    await recordActivationEvent(db as never, {
      companyId: "c1",
      agentId: "a1",
      heartbeatRunId: "r1",
      sink: "db",
      runStatus: "succeeded",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ eventType: "first_successful_run" });
  });

  it("does not write when the run status is unknown", async () => {
    const { db } = makeDb(0);
    await recordActivationEvent(db as never, {
      companyId: "c1",
      agentId: "a1",
      heartbeatRunId: "r1",
      sink: "db",
      runStatus: null,
    });
    expect(db.insertActivationEvent).not.toHaveBeenCalled();
  });

  it("swallows insert errors so it never breaks a run", async () => {
    const db = {
      countActivationForCompany: vi.fn(async () => 0),
      insertActivationEvent: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    await expect(
      recordActivationEvent(db as never, {
        companyId: "c1",
        agentId: "a1",
        heartbeatRunId: "r1",
        sink: "db",
        runStatus: "succeeded",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("createDrizzleActivationStore", () => {
  it("counts via select and inserts via insert", async () => {
    const calls: string[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: async () => {
            calls.push("count");
            return [{ n: 0 }];
          },
        }),
      }),
      insert: () => ({
        values: async () => {
          calls.push("insert");
        },
      }),
    };
    const store = createDrizzleActivationStore(fakeDb as never);
    expect(await store.countActivationForCompany("c1")).toBe(0);
    await store.insertActivationEvent({
      companyId: "c1",
      agentId: "a1",
      heartbeatRunId: "r1",
      eventType: "first_successful_run",
      firstForCompany: true,
      occurredAt: new Date(),
    });
    expect(calls).toEqual(["count", "insert"]);
  });
});

describe("hasActivationForCompany", () => {
  it("true when count > 0", async () => {
    const store = {
      countActivationForCompany: async () => 2,
      insertActivationEvent: async () => {},
    };
    expect(await hasActivationForCompany(store, "c1")).toBe(true);
  });
  it("false when count is 0", async () => {
    const store = {
      countActivationForCompany: async () => 0,
      insertActivationEvent: async () => {},
    };
    expect(await hasActivationForCompany(store, "c1")).toBe(false);
  });
});
