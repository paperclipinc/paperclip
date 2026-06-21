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
    });
    expect(inserted[0]).toMatchObject({ firstForCompany: false });
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
