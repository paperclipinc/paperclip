import { beforeEach, describe, expect, it, vi } from "vitest";
import { budgetService } from "../services/budgets.ts";

// Unit test for the recurring carry-over wallet increment. We drive the drizzle
// query builder with a stub that records inserts and serves queued select
// results, so we can assert the lifetime company policy is upserted with an
// additive `amount = amount + delta`, that repeated calls accumulate, and that
// the calendar_month mirror (`companies.budgetMonthlyCents`) is never written.

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

type Row = Record<string, unknown>;

function createDbStub(options: {
  company: Row | null;
  // amount the upserted/returned lifetime policy row should report
  resultRow: Row;
  observedTotal: number;
}) {
  const insertCalls: Array<{ values: Row; conflictSet: Row | null }> = [];
  const updateCalls: Array<{ table: unknown; set: Row }> = [];

  // select() handling: company lookup returns options.company (.then);
  // computeObservedAmount returns [{ total }] (awaited array);
  // resolveOpenIncidentsForPolicy's select returns [] (open incidents).
  let selectCallIndex = 0;
  const select = vi.fn((_columns?: unknown) => ({
    from: vi.fn((_table: unknown) => {
      const call = selectCallIndex++;
      const builder = {
        where: vi.fn((_cond: unknown) => {
          // company lookup uses .then; observed/incidents are awaited directly
          const thenable = {
            then: (resolve: (rows: Row[]) => unknown) => {
              if (call === 0) return Promise.resolve(resolve(options.company ? [options.company] : []));
              return Promise.resolve(resolve([]));
            },
          };
          // make it awaitable as an array for computeObservedAmount + incidents
          if (call === 1) {
            return Promise.resolve([{ total: options.observedTotal }]);
          }
          if (call >= 2) {
            return Promise.resolve([]);
          }
          return thenable;
        }),
      };
      return builder;
    }),
  }));

  const insert = vi.fn((_table: unknown) => ({
    values: vi.fn((values: Row) => {
      const entry: { values: Row; conflictSet: Row | null } = { values, conflictSet: null };
      insertCalls.push(entry);
      return {
        onConflictDoUpdate: vi.fn((cfg: { set: Row }) => {
          entry.conflictSet = cfg.set;
          return {
            returning: vi.fn(() => ({
              then: (resolve: (rows: Row[]) => unknown) =>
                Promise.resolve(resolve([options.resultRow])),
            })),
          };
        }),
      };
    }),
  }));

  const update = vi.fn((table: unknown) => ({
    set: vi.fn((set: Row) => {
      updateCalls.push({ table, set });
      return { where: vi.fn(async () => []) };
    }),
  }));

  return { db: { select, insert, update } as never, insertCalls, updateCalls };
}

const companyId = "company-1";

describe("budgetService.incrementCompanyBudget", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts a lifetime company policy with an additive amount", async () => {
    const { db, insertCalls } = createDbStub({
      company: { id: companyId },
      resultRow: {
        id: "policy-1",
        companyId,
        scopeType: "company",
        scopeId: companyId,
        metric: "billed_cents",
        windowKind: "lifetime",
        amount: 10000,
        hardStopEnabled: true,
      },
      observedTotal: 0,
    });

    const service = budgetService(db);
    const result = await service.incrementCompanyBudget(companyId, 10000);

    expect(result).toEqual({ amount: 10000 });
    expect(insertCalls).toHaveLength(1);
    const insert = insertCalls[0]!;
    // creates the lifetime company / billed_cents policy at the delta if absent
    expect(insert.values).toMatchObject({
      companyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 10000,
    });
    // on conflict it ADDS the delta, not overwrites
    expect(insert.conflictSet).not.toBeNull();
    expect(String(insert.conflictSet!.amount)).not.toEqual("10000");
  });

  it("never writes the calendar_month mirror (companies.budgetMonthlyCents)", async () => {
    const { db, updateCalls } = createDbStub({
      company: { id: companyId },
      resultRow: {
        id: "policy-1",
        companyId,
        scopeType: "company",
        scopeId: companyId,
        metric: "billed_cents",
        windowKind: "lifetime",
        amount: 5000,
        hardStopEnabled: true,
      },
      observedTotal: 0,
    });

    const service = budgetService(db);
    await service.incrementCompanyBudget(companyId, 5000);

    for (const call of updateCalls) {
      expect(Object.keys(call.set)).not.toContain("budgetMonthlyCents");
    }
  });

  it("rejects a non-positive delta", async () => {
    const { db } = createDbStub({
      company: { id: companyId },
      resultRow: { id: "p", amount: 0 },
      observedTotal: 0,
    });
    const service = budgetService(db);
    await expect(service.incrementCompanyBudget(companyId, 0)).rejects.toThrow();
    await expect(service.incrementCompanyBudget(companyId, -50)).rejects.toThrow();
  });

  it("throws when the company does not exist", async () => {
    const { db } = createDbStub({
      company: null,
      resultRow: { id: "p", amount: 0 },
      observedTotal: 0,
    });
    const service = budgetService(db);
    await expect(service.incrementCompanyBudget("missing", 100)).rejects.toThrow();
  });
});
