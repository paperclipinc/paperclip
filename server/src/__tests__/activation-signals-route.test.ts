import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The /cloud/activation-signals endpoint is a cloud-internal server-to-server
// read from the control-plane: its lifecycle-email sweep polls it once per
// cycle to score every company's activation progress (agent hired, first
// successful run, credential connected, recent usage) without re-deriving
// those facts itself. These tests pin its contract: the trusted header gate,
// and that the route is a thin pass-through to
// costService.listActivationSignals(), wrapped in a `{ companies: [...] }`
// envelope per the control-plane contract.

const listActivationSignals = vi.hoisted(() =>
  vi.fn(async (): Promise<
    Array<{
      companyId: string;
      hasAgent: boolean;
      hasCompletedRun: boolean;
      hasCredential: boolean;
      agentCount: number;
      lastActivityAt: Date | null;
      monthRunCount: number;
      monthCostCents: number;
    }>
  > => []),
);

vi.mock("../services/index.js", () => {
  const noop = () => ({});
  return {
    budgetService: noop,
    costService: () => ({ listActivationSignals }),
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

describe("GET /api/cloud/activation-signals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listActivationSignals.mockResolvedValue([]);
  });

  it("returns the activation signals for companies with any signal set", async () => {
    const lastActivityAt = new Date("2026-07-18T09:30:00Z");
    listActivationSignals.mockResolvedValue([
      {
        companyId: "22222222-2222-4222-8222-222222222222",
        hasAgent: true,
        hasCompletedRun: true,
        hasCredential: false,
        agentCount: 2,
        lastActivityAt,
        monthRunCount: 14,
        monthCostCents: 250,
      },
    ]);
    const app = await createApp();
    const res = await request(app)
      .get("/api/cloud/activation-signals")
      .set("x-paperclip-cloud-credit", "1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      companies: [
        {
          companyId: "22222222-2222-4222-8222-222222222222",
          hasAgent: true,
          hasCompletedRun: true,
          hasCredential: false,
          agentCount: 2,
          lastActivityAt: lastActivityAt.toISOString(),
          monthRunCount: 14,
          monthCostCents: 250,
        },
      ],
    });
    expect(listActivationSignals).toHaveBeenCalledTimes(1);
  });

  it("returns an empty companies list when nothing has activated", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/cloud/activation-signals")
      .set("x-paperclip-cloud-credit", "1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ companies: [] });
  });

  it("rejects requests without the trusted cloud-credit header", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/cloud/activation-signals");

    expect(res.status).toBe(403);
    expect(listActivationSignals).not.toHaveBeenCalled();
  });
});
