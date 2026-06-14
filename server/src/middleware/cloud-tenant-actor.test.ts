import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { resolveCloudTenantActor } from "./auth.js";

type SeededMembership = { companyId: string; membershipRole: string | null; status: string };

// Minimal fake Drizzle Db: records every table passed to .insert() and supports the
// chained call shapes used by resolveCloudTenantActor (values / onConflictDo* /
// returning().then()). The chain is awaitable so directly-awaited inserts resolve.
//
// `membershipRow` is the row returned by the company-membership UPSERT's
// .returning() (the stack-company auto-create). `seededMemberships` is the set of
// rows served by the SELECT over companyMemberships that the real implementation must
// use as the access list (mirrors the session actor's membership query); defaults to
// the single upserted owner membership so the backward-compat path is the default.
function createFakeDb(
  membershipRow: SeededMembership = { companyId: "company-x", membershipRole: "owner", status: "active" },
  seededMemberships?: SeededMembership[],
) {
  const insertedTables: unknown[] = [];
  const deletedTables: unknown[] = [];
  const selectedTables: unknown[] = [];
  const memberships = seededMemberships ?? [membershipRow];
  const chain: Record<string, unknown> = {};
  chain.values = () => chain;
  chain.onConflictDoUpdate = () => chain;
  chain.onConflictDoNothing = () => chain;
  chain.returning = async () => [membershipRow];
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  const db = {
    insert: (table: unknown) => {
      insertedTables.push(table);
      return chain;
    },
    // resolveCloudTenantActor SELECTs the user's real active companyMemberships
    // (db.select({...}).from(table).where(...) awaited to an array of rows).
    select: () => ({
      from: (table: unknown) => {
        selectedTables.push(table);
        return { where: async () => memberships };
      },
    }),
    // resolveCloudTenantActor awaits db.delete(table).where(...) to purge stale
    // instance_admin rows; the .where() result must be awaitable.
    delete: (table: unknown) => {
      deletedTables.push(table);
      return { where: async () => undefined };
    },
  } as unknown as Db;
  return { db, insertedTables, deletedTables, selectedTables };
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

describe("resolveCloudTenantActor (shared-pool hardening)", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
  });
  afterEach(() => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
  });

  it("never grants instance admin", async () => {
    const { db, insertedTables, deletedTables } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).not.toBeNull();
    expect(actor!.isInstanceAdmin).toBe(false);
    expect(insertedTables).not.toContain(instanceUserRoles);
    // and actively purges any stale instance_admin rows from earlier builds
    expect(deletedTables).toContain(instanceUserRoles);
  });

  it("is scoped to exactly the one company from its stack", async () => {
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor!.companyIds).toHaveLength(1);
    expect(actor!.memberships).toHaveLength(1);
    expect(actor?.memberships?.[0]?.companyId).toBe(actor?.companyIds?.[0]);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("owner");
    expect(actor!.source).toBe("cloud_tenant");
  });

  it("still upserts the user, company, and membership", async () => {
    const { db, insertedTables } = createFakeDb();
    await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(insertedTables).toContain(authUsers);
    expect(insertedTables).toContain(companies);
    expect(insertedTables).toContain(companyMemberships);
  });

  it("returns null when the server token is unset", async () => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).toBeNull();
  });

  it("maps a non-owner stack role through to the membership without elevating", async () => {
    const { db } = createFakeDb({ companyId: "company-y", membershipRole: "member", status: "active" });
    const actor = await resolveCloudTenantActor(
      db,
      fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-role": "member" }),
    );
    expect(actor!.isInstanceAdmin).toBe(false);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("member");
  });

  it("includes ALL active memberships, not just the stack company", async () => {
    // The user owns their stack company A and was also invited to company B (owned
    // by a different account/stack). Both must surface in the actor's access list.
    const stackCompany = { companyId: "company-a", membershipRole: "owner", status: "active" };
    const invitedCompany = { companyId: "company-b", membershipRole: "member", status: "active" };
    const { db, selectedTables } = createFakeDb(stackCompany, [stackCompany, invitedCompany]);
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

  it("with only the stack company still returns exactly that one (backward compat)", async () => {
    // Single-company regression guard: only the auto-created owner membership exists.
    const stackCompany = { companyId: "company-solo", membershipRole: "owner", status: "active" };
    const { db } = createFakeDb(stackCompany, [stackCompany]);
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));

    expect(actor!.companyIds).toEqual(["company-solo"]);
    expect(actor!.memberships).toHaveLength(1);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("owner");
    expect(actor?.memberships?.[0]?.companyId).toBe("company-solo");
    expect(actor!.source).toBe("cloud_tenant");
  });

  it("is never instance-admin (multi-company actor)", async () => {
    const stackCompany = { companyId: "company-a", membershipRole: "owner", status: "active" };
    const invitedCompany = { companyId: "company-b", membershipRole: "member", status: "active" };
    const { db } = createFakeDb(stackCompany, [stackCompany, invitedCompany]);
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor!.isInstanceAdmin).toBe(false);
  });
});
