import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Money-safety: in the managed cloud a tenant user is a board member of their own
// company, so the board-gated budget mutation routes would let them grant
// themselves budget without paying (raise the wallet cap, overwrite the lifetime
// wallet policy, drop the hard stop, or self-resume after a hard stop). When the
// `cloudBilling` instance flag is on, COMPANY-scope mutations must 403 with
// `budget_managed_by_billing`; the wallet is funded exclusively through the
// cloud-internal /budgets/increment path, which must keep working. Agent- and
// project-scope policies are NOT self-grants: they only sub-cap spending inside
// the company wallet (getInvocationBlock enforces the company policy first and
// independently), so they stay open under cloud billing. With the flag off
// (self-hosters) board budget control is unchanged.

const upsertPolicy = vi.hoisted(() => vi.fn(async () => ({ id: "policy-1" })));
const resolveIncident = vi.hoisted(() => vi.fn(async () => ({ id: "incident-1" })));
const incidentScopeType = vi.hoisted(() => ({ value: "company" as string | null }));
const getIncidentScopeType = vi.hoisted(() => vi.fn(async () => incidentScopeType.value));
const incrementCompanyBudget = vi.hoisted(() =>
  vi.fn(async (_companyId: string, deltaCents: number) => ({ amount: deltaCents })),
);
const companyUpdate = vi.hoisted(() =>
  vi.fn(async (companyId: string, patch: Record<string, unknown>) => ({ id: companyId, ...patch })),
);
const cloudBillingEnabled = vi.hoisted(() => ({ value: false }));

vi.mock("../services/index.js", () => {
  const noop = () => ({});
  return {
    budgetService: () => ({ upsertPolicy, resolveIncident, incrementCompanyBudget, getIncidentScopeType }),
    costService: noop,
    financeService: noop,
    companyService: () => ({ update: companyUpdate }),
    agentService: noop,
    issueService: noop,
    heartbeatService: () => ({ cancelBudgetScopeWork: vi.fn() }),
    accessService: noop,
    instanceSettingsService: () => ({
      getExperimental: async () => ({ cloudBilling: cloudBillingEnabled.value }),
    }),
    logActivity: vi.fn(),
  };
});

const companyId = "22222222-2222-4222-8222-222222222222";
const incidentId = "33333333-3333-4333-8333-333333333333";
const agentId = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";

async function createApp() {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/costs.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  // A cloud tenant user: board member of their own company, never instance admin.
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "cloud_tenant",
      userId: "tenant-user",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "admin" }],
    } as typeof req.actor;
    next();
  });
  app.use("/api", costRoutes({} as never));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  cloudBillingEnabled.value = false;
  incidentScopeType.value = "company";
});

describe("cloud billing budget self-grant gate", () => {
  describe("POST /api/companies/:companyId/budgets/policies", () => {
    const walletOverwrite = {
      scopeType: "company",
      scopeId: companyId,
      windowKind: "lifetime",
      amount: 100000000,
      hardStopEnabled: false,
    };

    it("403s with budget_managed_by_billing when cloud billing is on", async () => {
      cloudBillingEnabled.value = true;
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budgets/policies`)
        .send(walletOverwrite);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("budget_managed_by_billing");
      expect(res.body.error).toMatch(/billing/i);
      expect(upsertPolicy).not.toHaveBeenCalled();
    });

    it("stays open for board members when cloud billing is off", async () => {
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budgets/policies`)
        .send(walletOverwrite);

      expect(res.status).toBe(200);
      expect(upsertPolicy).toHaveBeenCalledTimes(1);
    });

    it("allows agent-scope policies when cloud billing is on (sub-cap inside the wallet)", async () => {
      cloudBillingEnabled.value = true;
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budgets/policies`)
        .send({
          scopeType: "agent",
          scopeId: agentId,
          windowKind: "calendar_month_utc",
          amount: 2000,
        });

      expect(res.status).toBe(200);
      expect(upsertPolicy).toHaveBeenCalledTimes(1);
    });

    it("allows project-scope policies when cloud billing is on (sub-cap inside the wallet)", async () => {
      cloudBillingEnabled.value = true;
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budgets/policies`)
        .send({
          scopeType: "project",
          scopeId: projectId,
          windowKind: "lifetime",
          amount: 2000,
        });

      expect(res.status).toBe(200);
      expect(upsertPolicy).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/companies/:companyId/budget-incidents/:incidentId/resolve", () => {
    it("403s raise_budget_and_resume on a company-scope incident when cloud billing is on", async () => {
      cloudBillingEnabled.value = true;
      incidentScopeType.value = "company";
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budget-incidents/${incidentId}/resolve`)
        .send({ action: "raise_budget_and_resume", amount: 100000000 });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("budget_managed_by_billing");
      expect(resolveIncident).not.toHaveBeenCalled();
    });

    it("allows raise_budget_and_resume on an agent-scope incident when cloud billing is on", async () => {
      cloudBillingEnabled.value = true;
      incidentScopeType.value = "agent";
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budget-incidents/${incidentId}/resolve`)
        .send({ action: "raise_budget_and_resume", amount: 5000 });

      expect(res.status).toBe(200);
      expect(resolveIncident).toHaveBeenCalledTimes(1);
    });

    it("allows raise_budget_and_resume on a project-scope incident when cloud billing is on", async () => {
      cloudBillingEnabled.value = true;
      incidentScopeType.value = "project";
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budget-incidents/${incidentId}/resolve`)
        .send({ action: "raise_budget_and_resume", amount: 5000 });

      expect(res.status).toBe(200);
      expect(resolveIncident).toHaveBeenCalledTimes(1);
    });

    it("fails closed (403) when the incident scope cannot be resolved and cloud billing is on", async () => {
      cloudBillingEnabled.value = true;
      incidentScopeType.value = null;
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budget-incidents/${incidentId}/resolve`)
        .send({ action: "raise_budget_and_resume", amount: 5000 });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("budget_managed_by_billing");
      expect(resolveIncident).not.toHaveBeenCalled();
    });

    it("still allows keep_paused when cloud billing is on", async () => {
      cloudBillingEnabled.value = true;
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budget-incidents/${incidentId}/resolve`)
        .send({ action: "keep_paused" });

      expect(res.status).toBe(200);
      expect(resolveIncident).toHaveBeenCalledTimes(1);
    });

    it("allows raise_budget_and_resume when cloud billing is off", async () => {
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budget-incidents/${incidentId}/resolve`)
        .send({ action: "raise_budget_and_resume", amount: 5000 });

      expect(res.status).toBe(200);
      expect(resolveIncident).toHaveBeenCalledTimes(1);
    });
  });

  describe("PATCH /api/companies/:companyId/budgets", () => {
    it("403s with budget_managed_by_billing when cloud billing is on", async () => {
      cloudBillingEnabled.value = true;
      const app = await createApp();
      const res = await request(app)
        .patch(`/api/companies/${companyId}/budgets`)
        .send({ budgetMonthlyCents: 100000000 });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("budget_managed_by_billing");
      expect(companyUpdate).not.toHaveBeenCalled();
      expect(upsertPolicy).not.toHaveBeenCalled();
    });

    it("stays open for board members when cloud billing is off", async () => {
      const app = await createApp();
      const res = await request(app)
        .patch(`/api/companies/${companyId}/budgets`)
        .send({ budgetMonthlyCents: 5000 });

      expect(res.status).toBe(200);
      expect(companyUpdate).toHaveBeenCalledTimes(1);
      expect(upsertPolicy).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/companies/:companyId/budgets/increment (cloud funding path)", () => {
    it("keeps working with cloud billing on (control-plane wallet credits)", async () => {
      cloudBillingEnabled.value = true;
      const app = await createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budgets/increment`)
        .set("x-paperclip-cloud-credit", "1")
        .send({ deltaCents: 10000 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ companyId, amount: 10000 });
      expect(incrementCompanyBudget).toHaveBeenCalledWith(companyId, 10000);
    });
  });
});
