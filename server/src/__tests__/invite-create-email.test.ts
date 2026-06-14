import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logActivityMock = vi.fn();

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      isInstanceAdmin: vi.fn(),
      canUser: vi.fn(),
      hasPermission: vi.fn(),
    }),
    agentService: () => ({
      getById: vi.fn(),
    }),
    boardAuthService: () => ({
      createChallenge: vi.fn(),
      resolveBoardAccess: vi.fn(),
      assertCurrentBoardKey: vi.fn(),
      revokeBoardApiKey: vi.fn(),
    }),
    deduplicateAgentName: vi.fn(),
    logActivity: (...args: unknown[]) => logActivityMock(...args),
    notifyHireApproved: vi.fn(),
  }));
}

function createDbStub() {
  const createdInvite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: { humanRole: "operator" },
    expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    invitedByUserId: null,
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };

  return {
    insert() {
      return {
        values() {
          return {
            returning() {
              return Promise.resolve([createdInvite]);
            },
          };
        },
      };
    },
    select(_shape?: unknown) {
      return {
        from() {
          const query = {
            leftJoin() {
              return query;
            },
            where() {
              return Promise.resolve([
                {
                  name: "Acme Robotics",
                  brandColor: "#114488",
                  logoAssetId: "logo-1",
                },
              ]);
            },
          };
          return query;
        },
      };
    },
  };
}

async function createApp() {
  const [{ accessRoutes }, { errorHandler }, inviteEmail] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
    // Imported from the same (post-reset) module graph the route uses, so the
    // transport singleton we set here is the one inviteEmailHook reads.
    import("../services/invite-email.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: null,
      companyIds: ["company-1"],
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(createDbStub() as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return { app, inviteEmail };
}

describe("invite create email delivery", () => {
  const sendInviteEmail = vi.fn(async () => {});

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    logActivityMock.mockReset();
    sendInviteEmail.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("emails the invitee when email is present and returns the inviteUrl", async () => {
    const { app, inviteEmail } = await createApp();
    inviteEmail.setInviteEmailTransport({ sendInviteEmail });

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({
        allowedJoinTypes: "human",
        humanRole: "operator",
        email: "teammate@example.com",
      });

    expect(res.status).toBe(201);
    expect(typeof res.body.inviteUrl).toBe("string");
    expect(res.body.inviteUrl.length).toBeGreaterThan(0);
    expect(sendInviteEmail).toHaveBeenCalledTimes(1);
    expect(sendInviteEmail).toHaveBeenCalledWith({
      email: "teammate@example.com",
      inviteUrl: res.body.inviteUrl,
      companyName: "Acme Robotics",
      role: "operator",
    });
  });

  it("does not email when no recipient email is present (link-copy fallback)", async () => {
    const { app, inviteEmail } = await createApp();
    inviteEmail.setInviteEmailTransport({ sendInviteEmail });

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({
        allowedJoinTypes: "human",
        humanRole: "operator",
      });

    expect(res.status).toBe(201);
    expect(typeof res.body.inviteUrl).toBe("string");
    expect(res.body.inviteUrl.length).toBeGreaterThan(0);
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });
});
