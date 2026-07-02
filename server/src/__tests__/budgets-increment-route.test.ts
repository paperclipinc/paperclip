import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The /budgets/increment endpoint is a cloud-internal server-to-server call from
// the control-plane: it credits the company's recurring carry-over budget wallet
// on each Paddle budget charge. These tests pin its contract — the trusted header
// gate, positive-integer validation, and that it delegates to
// budgetService.incrementCompanyBudget (the lifetime wallet path) and never the
// calendar_month upsert/mirror.

const incrementCompanyBudget = vi.hoisted(() =>
  vi.fn(async (_companyId: string, deltaCents: number) => ({ amount: deltaCents })),
);
const upsertPolicy = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => {
  const noop = () => ({});
  return {
    budgetService: () => ({ incrementCompanyBudget, upsertPolicy }),
    costService: noop,
    financeService: noop,
    companyService: noop,
    agentService: noop,
    issueService: noop,
    heartbeatService: () => ({ cancelBudgetScopeWork: vi.fn() }),
    accessService: noop,
    // The increment route is deliberately NOT gated on cloudBilling (it is the
    // cloud funding path); keep the flag on here to pin that.
    instanceSettingsService: () => ({
      getExperimental: async () => ({ cloudBilling: true }),
    }),
    logActivity: vi.fn(),
  };
});

const companyId = "22222222-2222-4222-8222-222222222222";

async function createApp() {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/costs.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  // No authenticated user actor: this is a server-to-server call.
  app.use((req, _res, next) => {
    req.actor = { type: "none", source: "none" } as typeof req.actor;
    next();
  });
  app.use("/api", costRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("POST /api/companies/:companyId/budgets/increment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    incrementCompanyBudget.mockImplementation(async (_companyId: string, deltaCents: number) => ({
      amount: deltaCents,
    }));
  });

  it("increments the lifetime wallet and returns the new cap", async () => {
    const app = await createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/budgets/increment`)
      .set("x-paperclip-cloud-credit", "1")
      .send({ deltaCents: 10000 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ companyId, amount: 10000 });
    expect(incrementCompanyBudget).toHaveBeenCalledTimes(1);
    expect(incrementCompanyBudget).toHaveBeenCalledWith(companyId, 10000);
    // never the calendar_month upsert / mirror path
    expect(upsertPolicy).not.toHaveBeenCalled();
  });

  it("accumulates across repeated calls (carry-over wallet)", async () => {
    let total = 0;
    incrementCompanyBudget.mockImplementation(async (_companyId: string, deltaCents: number) => {
      total += deltaCents;
      return { amount: total };
    });
    const app = await createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/budgets/increment`)
      .set("x-paperclip-cloud-credit", "1")
      .send({ deltaCents: 10000 });
    const second = await request(app)
      .post(`/api/companies/${companyId}/budgets/increment`)
      .set("x-paperclip-cloud-credit", "1")
      .send({ deltaCents: 5000 });

    expect(first.body.amount).toBe(10000);
    expect(second.body.amount).toBe(15000);
    expect(incrementCompanyBudget).toHaveBeenCalledTimes(2);
  });

  it("rejects requests without the trusted cloud-credit header", async () => {
    const app = await createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/budgets/increment`)
      .send({ deltaCents: 10000 });

    expect(res.status).toBe(403);
    expect(incrementCompanyBudget).not.toHaveBeenCalled();
  });

  it.each([0, -100, 12.5, "100", null])(
    "rejects a non-positive-integer deltaCents (%s)",
    async (deltaCents) => {
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budgets/increment`)
        .set("x-paperclip-cloud-credit", "1")
        .send({ deltaCents });

      expect(res.status).toBe(400);
      expect(incrementCompanyBudget).not.toHaveBeenCalled();
    },
  );
});
