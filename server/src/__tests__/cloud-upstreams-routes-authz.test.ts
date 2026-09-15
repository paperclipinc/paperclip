import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocked service surface used by the cloud-upstream routes. Every method is a
// spy so the tests can assert the handler refused to call into the service when
// the actor lacks access to the supplied/resolved companyId.
const mockService = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue({ connections: [], runs: [] }),
  startConnect: vi.fn().mockResolvedValue({ pendingConnectionId: "pending-1", authorizationUrl: "https://x/authorize?state=s" }),
  finishConnect: vi.fn().mockResolvedValue({ id: "conn-1" }),
  getConnectionCompanyId: vi.fn(),
  preview: vi.fn().mockResolvedValue({}),
  createRun: vi.fn().mockResolvedValue({}),
  readRun: vi.fn().mockResolvedValue({}),
  cancelRun: vi.fn().mockResolvedValue({}),
  activateRunEntities: vi.fn().mockResolvedValue({}),
}));

const mockSettings = vi.hoisted(() => ({
  getExperimental: vi.fn().mockResolvedValue({ enableCloudSync: true }),
}));

vi.mock("../services/index.js", () => ({
  cloudUpstreamService: () => mockService,
  instanceSettingsService: () => mockSettings,
}));

const companyA = "22222222-2222-4222-8222-222222222222";
const companyB = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyA],
    memberships: [{ companyId: companyA, status: "active", membershipRole: "admin" }],
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ cloudUpstreamRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/cloud-upstreams.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", cloudUpstreamRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe.sequential("cloud upstream route per-company authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.getExperimental.mockResolvedValue({ enableCloudSync: true });
  });

  it("rejects listing another company's upstreams", async () => {
    const app = await createApp(boardActor());
    const res = await request(app).get("/api/cloud-upstreams").query({ companyId: companyB });
    expect(res.status).toBe(403);
    expect(mockService.list).not.toHaveBeenCalled();
  });

  it("allows listing the actor's own company upstreams", async () => {
    const app = await createApp(boardActor());
    const res = await request(app).get("/api/cloud-upstreams").query({ companyId: companyA });
    expect(res.status).toBe(200);
    expect(mockService.list).toHaveBeenCalledWith(companyA);
  });

  it("rejects starting a connect against another company", async () => {
    const app = await createApp(boardActor());
    const res = await request(app)
      .post("/api/cloud-upstreams/connect/start")
      .send({ companyId: companyB, remoteUrl: "https://x", redirectUri: "https://y" });
    expect(res.status).toBe(403);
    expect(mockService.startConnect).not.toHaveBeenCalled();
  });

  it("rejects creating an export run against another company", async () => {
    const app = await createApp(boardActor());
    const res = await request(app)
      .post(`/api/cloud-upstreams/${connectionId}/push-runs`)
      .send({ companyId: companyB });
    expect(res.status).toBe(403);
    expect(mockService.createRun).not.toHaveBeenCalled();
  });

  it("rejects previewing an export run against another company", async () => {
    const app = await createApp(boardActor());
    const res = await request(app)
      .post(`/api/cloud-upstreams/${connectionId}/push-runs/preview`)
      .send({ companyId: companyB });
    expect(res.status).toBe(403);
    expect(mockService.preview).not.toHaveBeenCalled();
  });

  it("rejects reading an export run against another company", async () => {
    const app = await createApp(boardActor());
    const res = await request(app)
      .get(`/api/cloud-upstreams/${connectionId}/push-runs/${runId}`)
      .query({ companyId: companyB });
    expect(res.status).toBe(403);
    expect(mockService.readRun).not.toHaveBeenCalled();
  });

  it("rejects cancelling an export run against another company", async () => {
    const app = await createApp(boardActor());
    const res = await request(app)
      .post(`/api/cloud-upstreams/${connectionId}/push-runs/${runId}/cancel`)
      .send({ companyId: companyB });
    expect(res.status).toBe(403);
    expect(mockService.cancelRun).not.toHaveBeenCalled();
  });

  it("rejects activating run entities against another company", async () => {
    const app = await createApp(boardActor());
    const res = await request(app)
      .post(`/api/cloud-upstreams/${connectionId}/push-runs/${runId}/activation`)
      .send({ companyId: companyB, entityType: "agents" });
    expect(res.status).toBe(403);
    expect(mockService.activateRunEntities).not.toHaveBeenCalled();
  });

  it("rejects finishing a connect whose pending connection belongs to another company", async () => {
    mockService.getConnectionCompanyId.mockResolvedValue(companyB);
    const app = await createApp(boardActor());
    const res = await request(app)
      .post("/api/cloud-upstreams/connect/finish")
      .send({ pendingConnectionId: connectionId, code: "c", state: "s" });
    expect(res.status).toBe(403);
    expect(mockService.finishConnect).not.toHaveBeenCalled();
  });

  it("allows finishing a connect whose pending connection belongs to the actor's company", async () => {
    mockService.getConnectionCompanyId.mockResolvedValue(companyA);
    const app = await createApp(boardActor());
    const res = await request(app)
      .post("/api/cloud-upstreams/connect/finish")
      .send({ pendingConnectionId: connectionId, code: "c", state: "s" });
    expect(res.status).toBe(200);
    expect(mockService.finishConnect).toHaveBeenCalled();
  });
});
