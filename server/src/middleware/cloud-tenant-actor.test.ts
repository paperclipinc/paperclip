import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, instanceSettings, instanceUserRoles } from "@paperclipai/db";
import { resolveCloudTenantActor } from "./auth.js";

type SeededMembership = { companyId: string; membershipRole: string; status: string };

// Minimal fake Drizzle Db: records every table passed to .insert() / .delete() and
// supports the chained call shapes used by resolveCloudTenantActor (values /
// onConflictDo* / returning().then() / delete().where()), plus the
// select().from(table).where() reads: instanceSettings for the owner-elevation
// flag resolution through instanceSettingsService, and companyMemberships for
// the user's own membership rows (rows configurable via membershipQueryRows,
// where-conditions captured in selectWheres). The chain is awaitable so
// directly-awaited statements resolve.
function createFakeDb(options?: {
  membershipRow?: SeededMembership;
  seededMemberships?: SeededMembership[];
  /** Rows returned by the SELECT over `companies` — [] means the stack company does not exist yet. */
  companyRows?: Array<{ id: string }>;
  membershipQueryRows?: Array<{ companyId: string; membershipRole: string | null; status: string }>;
  settingsRow?: Record<string, unknown> | null;
  selectThrows?: boolean;
}) {
  const membershipRow: SeededMembership =
    options?.membershipRow ?? { companyId: "company-x", membershipRole: "owner", status: "active" };
  const settingsRow =
    options?.settingsRow === undefined
      ? {
          id: "00000000-0000-0000-0000-000000000001",
          singletonKey: "default",
          defaultEnvironmentId: null,
          general: {},
          experimental: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      : options?.settingsRow;
  const insertedTables: unknown[] = [];
  const deletedTables: unknown[] = [];
  const selectedTables: unknown[] = [];
  const insertedValues = new Map<unknown, Record<string, unknown>>();
  let currentTable: unknown = null;
  const memberships = options?.seededMemberships ?? [membershipRow];
  const companyRows = options?.companyRows ?? [];
  const selectWheres: Array<{ table: unknown; condition: unknown }> = [];
  const chain: Record<string, unknown> = {};
  chain.values = (values: Record<string, unknown>) => {
    if (currentTable !== null) insertedValues.set(currentTable, values);
    return chain;
  };
  chain.onConflictDoUpdate = () => chain;
  chain.onConflictDoNothing = () => chain;
  chain.returning = async () => [membershipRow];
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  const db = {
    insert: (table: unknown) => {
      insertedTables.push(table);
      currentTable = table;
      return chain;
    },
    select: () => {
      if (options?.selectThrows) throw new Error("select unavailable");
      return {
        from: (table: unknown) => {
          selectedTables.push(table);
          return {
            where: (condition: unknown) => {
              selectWheres.push({ table, condition });
              const result = table === companies
                ? companyRows
                : table === instanceSettings && settingsRow
                  ? [settingsRow]
                  : table === companyMemberships
                    ? memberships
                    : [];
              return {
                then: (resolve: (v: unknown) => unknown) =>
                  Promise.resolve(result).then(resolve),
              };
            },
          };
        },
      };
    },
    delete: (table: unknown) => {
      deletedTables.push(table);
      return { where: async () => undefined };
    },
  } as unknown as Db;
  return { db, insertedTables, deletedTables, selectedTables, insertedValues, selectWheres };
}

function settingsRowWith(experimental: Record<string, unknown>) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general: {},
    experimental,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeReq(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
}

const VALID_HEADERS = {
  "x-paperclip-cloud-tenant-token": "test-server-token",
  "x-paperclip-cloud-user-id": "user-123",
  "x-paperclip-cloud-user-email": "Owner@Example.com",
  "x-paperclip-cloud-stack-id": "stack-abc",
  "x-paperclip-cloud-stack-role": "owner",
};

const MANAGED_CONFIG_FLAG_ON = JSON.stringify({
  v: 1,
  mode: "cloud",
  catalogVersion: "test",
  features: { enableOwnerInstanceAdmin: true },
  plugins: { autoInstall: [] },
});

const MANAGED_CONFIG_FLAG_OFF = JSON.stringify({
  v: 1,
  mode: "cloud",
  catalogVersion: "test",
  features: { enableOwnerInstanceAdmin: false },
  plugins: { autoInstall: [] },
});

describe("resolveCloudTenantActor (shared-pool hardening)", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
  });
  afterEach(() => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
  });

  it("does not grant instance admin by default (flag off)", async () => {
    const { db, insertedTables, deletedTables } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).not.toBeNull();
    expect(actor!.isInstanceAdmin).toBe(false);
    expect(insertedTables).not.toContain(instanceUserRoles);
    // and actively purges any stale instance_admin rows from earlier builds
    expect(deletedTables).toContain(instanceUserRoles);
  });

  it("is scoped to exactly the one company from its stack", async () => {
    const { db } = createFakeDb({ companyRows: [{ id: "company-x" }] });
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor!.companyIds).toHaveLength(1);
    expect(actor!.memberships).toHaveLength(1);
    expect(actor?.memberships?.[0]?.companyId).toBe(actor?.companyIds?.[0]);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("owner");
    expect(actor!.source).toBe("cloud_tenant");
  });

  it("purges stale instance_admin rows left by pre-hardening deployments", async () => {
    const { db, deletedTables } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).not.toBeNull();
    expect(deletedTables).toContain(instanceUserRoles);
  });

  it("returns null when the server token is unset", async () => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).toBeNull();
  });

  it("maps a non-owner stack role through to the membership without elevating", async () => {
    const { db } = createFakeDb({
      membershipRow: { companyId: "company-y", membershipRole: "member", status: "active" },
      companyRows: [{ id: "company-y" }],
    });
    const actor = await resolveCloudTenantActor(
      db,
      fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-role": "member" }),
    );
    expect(actor!.isInstanceAdmin).toBe(false);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("member");
  });

  it("never creates the company (lazy creation)", async () => {
    const { db, insertedTables } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).not.toBeNull();
    expect(insertedTables).toContain(authUsers);
    expect(insertedTables).not.toContain(companies);
  });

  it("skips the membership upsert while the stack company does not exist", async () => {
    const { db, insertedTables } = createFakeDb({ companyRows: [], seededMemberships: [] });
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(insertedTables).not.toContain(companyMemberships);
    expect(actor!.companyIds).toEqual([]);
    expect(actor!.memberships).toEqual([]);
  });

  it("upserts the membership once the stack company exists", async () => {
    const { db, insertedTables } = createFakeDb({ companyRows: [{ id: "company-x" }] });
    await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(insertedTables).toContain(companyMemberships);
  });

  it("exposes the stack context on the actor", async () => {
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor!.cloudStack).toEqual({ stackId: "stack-abc", stackRole: "owner" });
  });

  it("captures the optional gateway stack slug on the stack context", async () => {
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(
      db,
      fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-slug": "jannes-stubbemann" }),
    );
    expect(actor!.cloudStack).toEqual({
      stackId: "stack-abc",
      stackRole: "owner",
      stackSlug: "jannes-stubbemann",
    });
  });

  it("ignores a blank stack slug header", async () => {
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(
      db,
      fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-slug": "   " }),
    );
    expect(actor!.cloudStack).toEqual({ stackId: "stack-abc", stackRole: "owner" });
  });

  it("exposes a non-creator stack role verbatim", async () => {
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(
      db,
      fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-role": "support" }),
    );
    expect(actor!.cloudStack).toEqual({ stackId: "stack-abc", stackRole: "support" });
  });

  // Fork-only behavior (upstream lacks it): the actor's access list is read back
  // from ALL of the user's active memberships, not just the stack company.
  it("includes ALL active memberships, not just the stack company", async () => {
    // The user owns their stack company A and was also invited to company B (owned
    // by a different account/stack). Both must surface in the actor's access list.
    const stackCompany = { companyId: "company-a", membershipRole: "owner", status: "active" };
    const invitedCompany = { companyId: "company-b", membershipRole: "member", status: "active" };
    const { db, selectedTables } = createFakeDb({
      membershipRow: stackCompany,
      seededMemberships: [stackCompany, invitedCompany],
      companyRows: [{ id: "company-a" }],
    });
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));

    expect(actor).not.toBeNull();
    // The access list reads the user's REAL memberships, not a synthesized 1:1.
    expect(selectedTables).toContain(companyMemberships);
    expect(actor!.companyIds).toEqual(expect.arrayContaining(["company-a", "company-b"]));
    expect(actor!.companyIds).toHaveLength(2);
    expect(actor!.memberships).toHaveLength(2);
    const byCompany = Object.fromEntries((actor!.memberships ?? []).map((m) => [m.companyId, m]));
    expect(byCompany["company-a"]?.membershipRole).toBe("owner");
    expect(byCompany["company-a"]?.status).toBe("active");
    expect(byCompany["company-b"]?.membershipRole).toBe("member");
    expect(byCompany["company-b"]?.status).toBe("active");
  });

  it("surfaces invited-company memberships even before the stack company exists", async () => {
    // Lazy creation must not hide companies the user was invited to: the stack
    // company is not created yet, but company B's membership is real.
    const invitedCompany = { companyId: "company-b", membershipRole: "member", status: "active" };
    const { db, insertedTables } = createFakeDb({
      seededMemberships: [invitedCompany],
      companyRows: [],
    });
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(insertedTables).not.toContain(companyMemberships);
    expect(actor!.companyIds).toEqual(["company-b"]);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("member");
  });

  it("with only the stack company still returns exactly that one (backward compat)", async () => {
    // Single-company regression guard: only the upserted owner membership exists.
    const stackCompany = { companyId: "company-solo", membershipRole: "owner", status: "active" };
    const { db } = createFakeDb({
      membershipRow: stackCompany,
      seededMemberships: [stackCompany],
      companyRows: [{ id: "company-solo" }],
    });
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));

    expect(actor!.companyIds).toEqual(["company-solo"]);
    expect(actor!.memberships).toHaveLength(1);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("owner");
    expect(actor?.memberships?.[0]?.companyId).toBe("company-solo");
    expect(actor!.source).toBe("cloud_tenant");
  });

  describe("owner instance-admin elevation (enableOwnerInstanceAdmin)", () => {
    it("elevates the owner while the flag is enabled, still without any role row", async () => {
      const { db, insertedTables, deletedTables } = createFakeDb({
        settingsRow: settingsRowWith({ enableOwnerInstanceAdmin: true }),
      });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor!.isInstanceAdmin).toBe(true);
      expect(actor!.source).toBe("cloud_tenant");
      // Elevation is computed, never persisted: no instance_user_roles insert,
      // and the stale-row purge still runs on every authentication.
      expect(insertedTables).not.toContain(instanceUserRoles);
      expect(deletedTables).toContain(instanceUserRoles);
    });

    it("does not elevate the owner while the flag is disabled", async () => {
      const { db } = createFakeDb({
        settingsRow: settingsRowWith({ enableOwnerInstanceAdmin: false }),
      });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor!.isInstanceAdmin).toBe(false);
    });

    it.each(["member", "admin", "support"] as const)(
      "never elevates the %s stack role even with the flag enabled",
      async (stackRole) => {
        const { db } = createFakeDb({
          membershipRow: { companyId: "company-y", membershipRole: "member", status: "active" },
          settingsRow: settingsRowWith({ enableOwnerInstanceAdmin: true }),
        });
        const actor = await resolveCloudTenantActor(
          db,
          fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-role": stackRole }),
        );
        expect(actor).not.toBeNull();
        expect(actor!.isInstanceAdmin).toBe(false);
      },
    );

    it("resolves the flag through the managed overlay: overlay on elevates over a DB value of off", async () => {
      process.env.PAPERCLIP_MANAGED_CONFIG = MANAGED_CONFIG_FLAG_ON;
      const { db } = createFakeDb({
        settingsRow: settingsRowWith({ enableOwnerInstanceAdmin: false }),
      });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor!.isInstanceAdmin).toBe(true);
    });

    it("resolves the flag through the managed overlay: overlay off wins over a DB value of on", async () => {
      process.env.PAPERCLIP_MANAGED_CONFIG = MANAGED_CONFIG_FLAG_OFF;
      const { db } = createFakeDb({
        settingsRow: settingsRowWith({ enableOwnerInstanceAdmin: true }),
      });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor!.isInstanceAdmin).toBe(false);
    });

    it("fails closed when the settings read errors: actor resolves without elevation", async () => {
      const { db, deletedTables } = createFakeDb({ selectThrows: true });
      const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
      expect(actor).not.toBeNull();
      expect(actor!.isInstanceAdmin).toBe(false);
      expect(deletedTables).toContain(instanceUserRoles);
    });
  });
});
