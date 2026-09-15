import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The /cloud/budget-paused endpoint is a cloud-internal server-to-server read
// from the control-plane: its lifecycle sweep polls it to find companies paused
// by the budget hard-stop (to email a trial that hit the wall). These tests pin
// its contract — the trusted header gate and that it returns exactly what
// budgetService.listBudgetPausedCompanies reports.

const listBudgetPausedCompanies = vi.hoisted(() =>
  vi.fn(async (): Promise<{ companyId: string; pausedAt: Date | null }[]> => []),
);

vi.mock("../services/index.js", () => {
  const noop = () => ({});
  return {
    budgetService: () => ({ listBudgetPausedCompanies }),
    costService: noop,
    financeService: noop,
    companyService: noop,
    agentService: noop,
    issueService: noop,
    heartbeatService: () => ({ cancelBudgetScopeWork: vi.fn() }),
    accessService: noop,
    instanceSettingsService: () => ({
      getExperimental: async () => ({ cloudBilling: true }),
    }),
    logActivity: vi.fn(),
  };
});

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

describe("GET /api/cloud/budget-paused", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBudgetPausedCompanies.mockResolvedValue([]);
  });

  it("returns the budget-paused companies with their pausedAt", async () => {
    const pausedAt = new Date("2026-07-04T10:00:00Z");
    listBudgetPausedCompanies.mockResolvedValue([
      { companyId: "22222222-2222-4222-8222-222222222222", pausedAt },
    ]);
    const app = await createApp();
    const res = await request(app)
      .get("/api/cloud/budget-paused")
      .set("x-paperclip-cloud-credit", "1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { companyId: "22222222-2222-4222-8222-222222222222", pausedAt: pausedAt.toISOString() },
    ]);
    expect(listBudgetPausedCompanies).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list when nothing is paused for budget", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/cloud/budget-paused")
      .set("x-paperclip-cloud-credit", "1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rejects requests without the trusted cloud-credit header", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/cloud/budget-paused");

    expect(res.status).toBe(403);
    expect(listBudgetPausedCompanies).not.toHaveBeenCalled();
  });
});
