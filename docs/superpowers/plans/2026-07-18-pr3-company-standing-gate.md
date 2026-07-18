# PR-3: Company-Standing Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec §5 of `docs/superpowers/specs/2026-07-18-settings-visibility-and-plugin-enablement-design.md`: a generic per-company, per-plugin standing record (`active` | `grace` | `blocked`) that governance plugins (billing, compliance, quota) write via a new capability-gated host service, that blocks new agent runs at the heartbeat run-start gate when effectively `blocked`, that is cleaned up whenever the writing plugin is uninstalled/disabled, and that surfaces in the UI as a layout banner and company-switcher badges. Core learns nothing about money.

**Architecture:** One new core table `company_standing` (composite PK `company_id`+`plugin_id`, row-per-plugin so plugins cannot clobber each other). One new service `companyStandingService(db)` owning writes, severity merge (`blocked` > `grace` > `active`, no rows ⇒ `active`), and cleanup. Plugins reach it via the existing worker→host RPC chain: `ctx.companies.setStanding/clearStanding` (SDK `worker-rpc-host.ts`) → JSON-RPC methods `companies.setStanding`/`companies.clearStanding` (`protocol.ts`) → capability-gated handlers (`host-client-factory.ts`, capability `company.standing.write`) → `HostServices.companies` implementation (`plugin-host-services.ts`, pluginId injected from the worker's identity — plugins can never write another plugin's rows). Enforcement is a single check in `heartbeat.ts#enqueueWakeup` beside the existing budget hard-stop (`budgets.getInvocationBlock`), throwing a typed 409 `company_blocked` error. Standings ride the `/cli-auth/me` payload (`capabilities.companyStandings`) for the UI.

**Tech Stack:** TypeScript strict, pnpm workspaces, Drizzle ORM (hand-written SQL migrations on this fork), Express, vitest (embedded-postgres for server integration tests, jsdom for UI tests), React + TanStack Query + Tailwind.

## Global Constraints

1. **Migration numbering & the fork's broken snapshot chain (critical).** This fork's drizzle snapshot chain is forked on master: `drizzle-kit generate` FAILS and must NOT be run. Snapshots in `packages/db/src/migrations/meta/` stop at `0099_snapshot.json`; migrations `0100+` are maintained by hand. The current max migration is `0172_issue_create_idempotency_keys.sql`. PR-1 (stacked below this slice) adds `0173_instance_settings_visibility.sql`, so this PR adds **`0174_company_standing.sql`** written by hand, plus a hand-appended entry in `packages/db/src/migrations/meta/_journal.json` (mirroring entries 0171/0172: `"version": "7"`, round `"when"` epoch-ms, `"breakpoints": true`). **Stacked-slice rebase renumbering:** PR-3 stacks after PR-1/PR-2 in slice order. If an earlier slice (or an upstream rebase) lands a migration first, renumber before merging: (a) rename `0174_company_standing.sql` to the new max+1 (e.g. `0175_company_standing.sql`); (b) update the journal entry's `"idx"` to match the number and `"tag"` to the new filename stem; (c) keep `"when"` strictly greater than the previous entry's; (d) nothing else references the number — schema TS files and code are migration-number-agnostic.
2. **Never commit `pnpm-lock.yaml`.** This PR adds no dependencies, so the lockfile must not change at all.
3. **Fail-safe semantics (spec §5.3).** Unknown/unwritten/unparseable = `active`. Only an explicitly persisted `blocked` row stops work. `grace` NEVER blocks anything — it exists only so UIs can warn. Reads, settings, and all company pages stay fully accessible; only new-run starts are refused.
4. **PR-1 coupling (single point).** PR-1 introduces a `capabilities` object on `GET /cli-auth/me`. In this worktree PR-1 is not merged: the route (`server/src/routes/access.ts:2853-2868`) returns no `capabilities` field. Task 8 adds `capabilities: { companyStandings }` as a new field. When rebasing onto a merged PR-1, fold `companyStandings` into PR-1's existing `capabilities` object instead of adding a second one. This is the ONLY cross-PR touch point.
5. **Typed-error convention.** `HttpError` (`server/src/errors.ts:1-10`) carries `status` + `details`; machine codes go in `details.code` (existing example: `heartbeat.ts:15083-15092` uses `code: "responsible_user_unresolved"`). The `company_blocked` error follows this: `conflict(message, { code: "company_blocked", ... })`.
6. **Commit style.** Conventional commits; every commit message ends with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do not push; do not touch CI config.
7. **Test runners.** Server: `pnpm --filter @paperclipai/server exec vitest run <path relative to server/>`. Shared: `pnpm --filter @paperclipai/shared exec vitest run <path relative to packages/shared/>`. Plugin SDK: `pnpm --filter @paperclipai/plugin-sdk exec vitest run <path relative to packages/plugins/sdk/>`. UI: `pnpm --filter @paperclipai/ui exec vitest run <path relative to ui/>`. Embedded-postgres suites self-skip on unsupported hosts (`getEmbeddedPostgresTestSupport()`); a skip is not a pass — run on a host where they execute. Final gate: `pnpm typecheck` from repo root.
8. **Capability metadata reality.** `PLUGIN_CAPABILITIES` (`packages/shared/src/constants.ts:1218-1298`) is a flat `as const` string array organized by group comments — there is no per-entry group/sensitivity metadata structure anywhere in the codebase, and no install-screen sensitivity flag mechanism exists. `"company.standing.write"` is therefore appended as a plain string in the "Data Write" comment group (deviation from the spec's "flagged sensitive on the install screen" — no such mechanism exists to hook into; the capability name itself is what install screens render today).

---

## Task 1: Shared constants — standing statuses, `EffectiveStanding`, `company.standing.write` capability

**Files:**
- Modify: `packages/shared/src/constants.ts` (capability array :1218-1298 — append in the "Data Write" group, which ends with `"external.objects.refresh"` at :1275; new constants after `PluginCapability` type at :1299)
- Modify: `packages/shared/src/index.ts` (value export block containing `PLUGIN_CAPABILITIES,` at :314; type export containing `type PluginCapability,` at :459)
- Test: `packages/shared/src/company-standing.test.ts` (new — shared tests live as `packages/shared/src/*.test.ts`, e.g. `resource-memberships.test.ts`)

**Interfaces:**
- Produces: `COMPANY_STANDING_STATUSES: readonly ["active", "grace", "blocked"]`, `type CompanyStandingStatus = "active" | "grace" | "blocked"`, `interface EffectiveStanding { status: CompanyStandingStatus; reason?: string; message?: string; actionUrl?: string }`, `"company.standing.write"` member of `PLUGIN_CAPABILITIES`/`PluginCapability`.
- Consumed by: Tasks 2, 3, 4, 5.

**Steps:**

- [ ] Write the failing test `packages/shared/src/company-standing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  COMPANY_STANDING_STATUSES,
  PLUGIN_CAPABILITIES,
  type EffectiveStanding,
} from "./index.js";

describe("company standing shared constants", () => {
  it("declares the three standing statuses in severity order", () => {
    expect(COMPANY_STANDING_STATUSES).toEqual(["active", "grace", "blocked"]);
  });

  it("declares the company.standing.write plugin capability", () => {
    expect(PLUGIN_CAPABILITIES).toContain("company.standing.write");
  });

  it("EffectiveStanding permits a minimal active value", () => {
    const standing: EffectiveStanding = { status: "active" };
    expect(standing.status).toBe("active");
  });
});
```

- [ ] Run it — expected failure: `pnpm --filter @paperclipai/shared exec vitest run src/company-standing.test.ts` fails to compile (`COMPANY_STANDING_STATUSES` / `EffectiveStanding` not exported).
- [ ] In `packages/shared/src/constants.ts`, append the capability inside `PLUGIN_CAPABILITIES` at the end of the Data Write group (immediately after `"external.objects.refresh",` and before the `// Plugin State` comment):

```ts
  "company.standing.write",
```

- [ ] Still in `constants.ts`, immediately after `export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];` (line 1299), add:

```ts
/**
 * Company standing — a per-company, per-plugin governance record written by
 * plugins holding `company.standing.write` (e.g. billing, compliance, quota).
 *
 * Effective standing per company is the most severe row across all plugins
 * (`blocked` > `grace` > `active`); no rows ⇒ `active`. Only an explicit,
 * persisted `blocked` row stops new work (fail-safe: unknown = active).
 */
export const COMPANY_STANDING_STATUSES = ["active", "grace", "blocked"] as const;
export type CompanyStandingStatus = (typeof COMPANY_STANDING_STATUSES)[number];

/**
 * The merged, most-severe standing for one company. `reason` is a short
 * machine code (e.g. `subscription_lapsed`), `message` is human text for
 * banners/errors, `actionUrl` is an optional deep link (e.g. billing page).
 */
export interface EffectiveStanding {
  status: CompanyStandingStatus;
  reason?: string;
  message?: string;
  actionUrl?: string;
}
```

- [ ] In `packages/shared/src/index.ts`, add `COMPANY_STANDING_STATUSES,` on the line after `PLUGIN_CAPABILITIES,` (:314) in the value export block, and add `type CompanyStandingStatus,` and `type EffectiveStanding,` on the lines after `type PluginCapability,` (:459) in the same export statement.
- [ ] Run again — expected pass: `pnpm --filter @paperclipai/shared exec vitest run src/company-standing.test.ts` (3 passing).
- [ ] Commit:

```bash
git add packages/shared/src/constants.ts packages/shared/src/index.ts packages/shared/src/company-standing.test.ts
git commit -m "feat(shared): add company standing statuses, EffectiveStanding, and company.standing.write capability

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: `company_standing` table — Drizzle schema + hand-written migration 0174

**Files:**
- Create: `packages/db/src/schema/company_standing.ts`
- Create: `packages/db/src/migrations/0174_company_standing.sql`
- Modify: `packages/db/src/schema/index.ts` (add export next to `export { pluginCompanySettings } from "./plugin_company_settings.js";` at :141)
- Modify: `packages/db/src/migrations/meta/_journal.json` (append entry after idx 172)
- Test: covered by Task 3's embedded-postgres suite (the embedded test DB applies the migrations folder; a missing/incorrect 0174 makes every Task 3 test fail on `relation "company_standing" does not exist`). No standalone schema test — this matches how 0171/0172 landed.

**Interfaces:**
- Produces: `companyStanding` Drizzle table export from `@paperclipai/db` (the package barrel `packages/db/src/index.ts:40` does `export * from "./schema/index.js";` so the schema barrel is sufficient).
- Consumes: `companies` (`packages/db/src/schema/companies.ts`), `plugins` (`packages/db/src/schema/plugins.ts`), `CompanyStandingStatus` (Task 1).

**Steps:**

- [ ] Create `packages/db/src/schema/company_standing.ts` (composite-PK style mirrors `project_goals.ts`; column style mirrors `plugin_company_settings.ts`):

```ts
import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CompanyStandingStatus } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

/**
 * `company_standing` table — one row per (company, plugin) pair written by a
 * plugin holding `company.standing.write` (billing, compliance, quota, …).
 *
 * Row-per-plugin so plugins cannot clobber each other; the effective standing
 * for a company is the most severe row (`blocked` > `grace` > `active`), and
 * no rows means `active` (fail-safe — a crashed or removed plugin can never
 * leave a company stranded; cleanup hooks delete rows on uninstall/disable).
 */
export const companyStanding = pgTable(
  "company_standing",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    status: text("status").$type<CompanyStandingStatus>().notNull(),
    /** Short machine code, e.g. `subscription_lapsed`. */
    reason: text("reason").notNull(),
    /** Human text shown in banners/errors. */
    message: text("message").notNull(),
    /** Optional deep link, e.g. the billing page. */
    actionUrl: text("action_url"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.pluginId] }),
    companyIdx: index("company_standing_company_idx").on(table.companyId),
    pluginIdx: index("company_standing_plugin_idx").on(table.pluginId),
  }),
);
```

- [ ] Create `packages/db/src/migrations/0174_company_standing.sql` by hand (style mirrors `0171_company_skill_policies.sql` / `0172_issue_create_idempotency_keys.sql` — `CREATE TABLE IF NOT EXISTS`, quoted identifiers, `--> statement-breakpoint` separators, text + CHECK instead of pg enums):

```sql
CREATE TABLE IF NOT EXISTS "company_standing" (
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "plugin_id" uuid NOT NULL REFERENCES "plugins"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "reason" text NOT NULL,
  "message" text NOT NULL,
  "action_url" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "company_standing_pkey" PRIMARY KEY ("company_id", "plugin_id"),
  CONSTRAINT "company_standing_status_check" CHECK ("status" IN ('active', 'grace', 'blocked'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_standing_company_idx"
  ON "company_standing" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_standing_plugin_idx"
  ON "company_standing" USING btree ("plugin_id");
```

- [ ] Append to the `entries` array in `packages/db/src/migrations/meta/_journal.json`, after the idx-172 entry (comma after the previous entry's closing brace; `when` = 2026-07-18T00:00:00Z, round, strictly greater than 0172's `1784160000000`):

```json
    {
      "idx": 174,
      "version": "7",
      "when": 1784332800000,
      "tag": "0174_company_standing",
      "breakpoints": true
    }
```

- [ ] In `packages/db/src/schema/index.ts`, add after line 141 (`export { pluginCompanySettings } from "./plugin_company_settings.js";`):

```ts
export { companyStanding } from "./company_standing.js";
```

- [ ] Verify: `pnpm --filter @paperclipai/db typecheck` passes (schema compiles, barrel resolves) and `python3 -c "import json; json.load(open('packages/db/src/migrations/meta/_journal.json'))"` exits 0 (journal still valid JSON). Do NOT run `drizzle-kit generate` (Global Constraint 1).
- [ ] Commit:

```bash
git add packages/db/src/schema/company_standing.ts packages/db/src/schema/index.ts packages/db/src/migrations/0174_company_standing.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add company_standing table (hand-written migration 0174)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: `companyStandingService` — writes, severity merge, cleanup helpers

**Files:**
- Create: `server/src/services/company-standing.ts`
- Modify: `server/src/services/index.ts` (add export after line 7, `export { companySkillPolicyService, ... }`)
- Test: `server/src/__tests__/company-standing-service.test.ts` (new; embedded-postgres pattern from `server/src/__tests__/budgets-service.test.ts:346-370`)

**Interfaces:**
- Produces (pinned contract, exact):
  - `setStanding(pluginId: string, companyId: string, input: { status: "active" | "grace" | "blocked"; reason: string; message: string; actionUrl?: string }): Promise<void>`
  - `clearStanding(pluginId: string, companyId: string): Promise<void>`
  - `getEffectiveStanding(companyId: string): Promise<EffectiveStanding>`
  - `getEffectiveStandings(companyIds: string[]): Promise<Record<string, EffectiveStanding>>`
  - Plus cleanup helper (addition for Task 6): `clearAllForPlugin(pluginId: string): Promise<void>`
- Consumes: `companyStanding` table (Task 2), `EffectiveStanding`/`COMPANY_STANDING_STATUSES` (Task 1), `badRequest` from `server/src/errors.ts`.

**Steps:**

- [ ] Write the failing test `server/src/__tests__/company-standing-service.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyStanding, createDb, plugins } from "@paperclipai/db";
import {
  closeDbClient,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyStandingService } from "../services/company-standing.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company-standing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyStandingService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-standing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyStanding);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Standing Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertPlugin(key: string) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: key,
      packageName: `@paperclipai/${key}`,
      version: "1.0.0",
      manifestJson: {
        id: key,
        name: key,
        version: "1.0.0",
        capabilities: ["company.standing.write"],
      } as never,
      status: "ready",
    });
    return pluginId;
  }

  it("returns active when no rows exist (fail-safe default)", async () => {
    const companyId = await insertCompany();
    const service = companyStandingService(db);
    await expect(service.getEffectiveStanding(companyId)).resolves.toEqual({ status: "active" });
    await expect(service.getEffectiveStandings([companyId])).resolves.toEqual({
      [companyId]: { status: "active" },
    });
    await expect(service.getEffectiveStandings([])).resolves.toEqual({});
  });

  it("upserts one row per (company, plugin) and returns its fields", async () => {
    const companyId = await insertCompany();
    const pluginId = await insertPlugin("paperclip.billing");
    const service = companyStandingService(db);

    await service.setStanding(pluginId, companyId, {
      status: "grace",
      reason: "payment_failed",
      message: "Your last payment failed.",
      actionUrl: "/billing",
    });
    await expect(service.getEffectiveStanding(companyId)).resolves.toEqual({
      status: "grace",
      reason: "payment_failed",
      message: "Your last payment failed.",
      actionUrl: "/billing",
    });

    // Second write from the same plugin replaces, not duplicates.
    await service.setStanding(pluginId, companyId, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Subscription lapsed.",
    });
    const rows = await db.select().from(companyStanding);
    expect(rows).toHaveLength(1);
    await expect(service.getEffectiveStanding(companyId)).resolves.toEqual({
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Subscription lapsed.",
    });
  });

  it("merges by severity across plugins: blocked > grace > active", async () => {
    const companyId = await insertCompany();
    const billing = await insertPlugin("paperclip.billing");
    const compliance = await insertPlugin("paperclip.compliance");
    const quota = await insertPlugin("paperclip.quota");
    const service = companyStandingService(db);

    await service.setStanding(billing, companyId, {
      status: "active",
      reason: "ok",
      message: "All good.",
    });
    await service.setStanding(compliance, companyId, {
      status: "grace",
      reason: "review_pending",
      message: "Compliance review pending.",
      actionUrl: "/compliance",
    });
    await expect(service.getEffectiveStanding(companyId)).resolves.toMatchObject({
      status: "grace",
      reason: "review_pending",
    });

    await service.setStanding(quota, companyId, {
      status: "blocked",
      reason: "quota_exceeded",
      message: "Quota exceeded.",
    });
    await expect(service.getEffectiveStanding(companyId)).resolves.toMatchObject({
      status: "blocked",
      reason: "quota_exceeded",
      message: "Quota exceeded.",
    });
  });

  it("clearStanding removes only the calling plugin's row", async () => {
    const companyId = await insertCompany();
    const billing = await insertPlugin("paperclip.billing");
    const compliance = await insertPlugin("paperclip.compliance");
    const service = companyStandingService(db);

    await service.setStanding(billing, companyId, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Subscription lapsed.",
    });
    await service.setStanding(compliance, companyId, {
      status: "grace",
      reason: "review_pending",
      message: "Review pending.",
    });

    await service.clearStanding(billing, companyId);
    await expect(service.getEffectiveStanding(companyId)).resolves.toMatchObject({ status: "grace" });

    await service.clearStanding(compliance, companyId);
    await expect(service.getEffectiveStanding(companyId)).resolves.toEqual({ status: "active" });
  });

  it("clearAllForPlugin deletes the plugin's rows across all companies", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const billing = await insertPlugin("paperclip.billing");
    const service = companyStandingService(db);

    await service.setStanding(billing, companyA, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Lapsed.",
    });
    await service.setStanding(billing, companyB, {
      status: "grace",
      reason: "payment_failed",
      message: "Failed.",
    });

    await service.clearAllForPlugin(billing);
    await expect(service.getEffectiveStandings([companyA, companyB])).resolves.toEqual({
      [companyA]: { status: "active" },
      [companyB]: { status: "active" },
    });
  });

  it("getEffectiveStandings scopes rows to the requested companies", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const billing = await insertPlugin("paperclip.billing");
    const service = companyStandingService(db);

    await service.setStanding(billing, companyB, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Lapsed.",
    });

    await expect(service.getEffectiveStandings([companyA])).resolves.toEqual({
      [companyA]: { status: "active" },
    });
  });

  it("rejects invalid input", async () => {
    const companyId = await insertCompany();
    const billing = await insertPlugin("paperclip.billing");
    const service = companyStandingService(db);

    await expect(
      service.setStanding(billing, companyId, {
        status: "frozen" as never,
        reason: "x",
        message: "y",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.setStanding(billing, companyId, { status: "blocked", reason: "", message: "y" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.setStanding(billing, companyId, { status: "blocked", reason: "x", message: "  " }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
```

- [ ] Run it — expected failure: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/company-standing-service.test.ts` fails at import (`../services/company-standing.ts` does not exist).
- [ ] Create `server/src/services/company-standing.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyStanding } from "@paperclipai/db";
import {
  COMPANY_STANDING_STATUSES,
  type CompanyStandingStatus,
  type EffectiveStanding,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";

/** Severity order for the merge: blocked > grace > active. */
const STANDING_SEVERITY: Record<CompanyStandingStatus, number> = {
  active: 0,
  grace: 1,
  blocked: 2,
};

export interface SetStandingInput {
  status: CompanyStandingStatus;
  reason: string;
  message: string;
  actionUrl?: string;
}

/**
 * Company standing — the one generic hook a billing/compliance/quota plugin
 * needs: declare that a company may not start new work, without core knowing
 * anything about money (spec §5).
 *
 * Rows are always scoped to the writing plugin (row-per-plugin composite PK),
 * and the effective standing per company is the most severe row. Fail-safe:
 * no rows / unknown values ⇒ `active`; only an explicit persisted `blocked`
 * row stops work.
 */
export function companyStandingService(db: Db) {
  return {
    /** Insert or replace the calling plugin's standing row for a company. */
    async setStanding(pluginId: string, companyId: string, input: SetStandingInput): Promise<void> {
      if (!COMPANY_STANDING_STATUSES.includes(input.status)) {
        throw badRequest(
          `Invalid standing status '${String(input.status)}'. Expected one of: ${COMPANY_STANDING_STATUSES.join(", ")}`,
        );
      }
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      const message = typeof input.message === "string" ? input.message.trim() : "";
      if (!reason) throw badRequest("Standing 'reason' is required");
      if (!message) throw badRequest("Standing 'message' is required");
      const actionUrl =
        typeof input.actionUrl === "string" && input.actionUrl.trim().length > 0
          ? input.actionUrl.trim()
          : null;

      await db
        .insert(companyStanding)
        .values({
          companyId,
          pluginId,
          status: input.status,
          reason,
          message,
          actionUrl,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [companyStanding.companyId, companyStanding.pluginId],
          set: {
            status: input.status,
            reason,
            message,
            actionUrl,
            updatedAt: new Date(),
          },
        });
    },

    /** Delete the calling plugin's standing row for a company (idempotent). */
    async clearStanding(pluginId: string, companyId: string): Promise<void> {
      await db
        .delete(companyStanding)
        .where(
          and(
            eq(companyStanding.pluginId, pluginId),
            eq(companyStanding.companyId, companyId),
          ),
        );
    },

    /** Effective standing for one company (most severe row; none ⇒ active). */
    async getEffectiveStanding(companyId: string): Promise<EffectiveStanding> {
      const standings = await this.getEffectiveStandings([companyId]);
      return standings[companyId] ?? { status: "active" };
    },

    /**
     * Effective standings for a set of companies in one query. Every requested
     * company is present in the result (fail-safe default `{ status: "active" }`).
     */
    async getEffectiveStandings(companyIds: string[]): Promise<Record<string, EffectiveStanding>> {
      const result: Record<string, EffectiveStanding> = {};
      for (const companyId of companyIds) {
        result[companyId] = { status: "active" };
      }
      if (companyIds.length === 0) return result;

      const rows = await db
        .select()
        .from(companyStanding)
        .where(inArray(companyStanding.companyId, companyIds));

      for (const row of rows) {
        const status = row.status as CompanyStandingStatus;
        // Fail-safe: ignore rows with values outside the known enum.
        if (!COMPANY_STANDING_STATUSES.includes(status)) continue;
        const current = result[row.companyId] ?? { status: "active" };
        if (STANDING_SEVERITY[status] > STANDING_SEVERITY[current.status]) {
          result[row.companyId] = {
            status,
            reason: row.reason,
            message: row.message,
            ...(row.actionUrl ? { actionUrl: row.actionUrl } : {}),
          };
        }
      }
      return result;
    },

    /**
     * Delete every standing row a plugin has written, across all companies.
     * Called on plugin uninstall / instance-disable so a removed governance
     * plugin can never leave companies stranded (spec §5.2).
     */
    async clearAllForPlugin(pluginId: string): Promise<void> {
      await db.delete(companyStanding).where(eq(companyStanding.pluginId, pluginId));
    },
  };
}

export type CompanyStandingService = ReturnType<typeof companyStandingService>;
```

- [ ] In `server/src/services/index.ts`, add after line 7 (`export { companySkillPolicyService, normalizeSkillPolicySourceType } from "./company-skill-policy.js";`):

```ts
export { companyStandingService, type CompanyStandingService, type SetStandingInput } from "./company-standing.js";
```

- [ ] Run again — expected pass: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/company-standing-service.test.ts` (7 passing; suite skips only on hosts without embedded-postgres support).
- [ ] Commit:

```bash
git add server/src/services/company-standing.ts server/src/services/index.ts server/src/__tests__/company-standing-service.test.ts
git commit -m "feat(server): add companyStandingService with severity merge and cleanup helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: RPC + capability plumbing — protocol methods, capability maps, SDK client

**Files:**
- Modify: `packages/plugins/sdk/src/protocol.ts` (add methods after the `"companies.get"` entry at :1155-1158)
- Modify: `packages/plugins/sdk/src/host-client-factory.ts` (HostServices `companies` group :185-189; `METHOD_CAPABILITY_MAP` companies entries :409-410; handler map companies handlers :772-782)
- Modify: `packages/plugins/sdk/src/worker-rpc-host.ts` (ctx `companies` block :742-753)
- Modify: `packages/plugins/sdk/src/types.ts` (`PluginCompaniesClient` :1071-1081)
- Modify: `server/src/services/plugin-capability-validator.ts` (`OPERATION_CAPABILITIES`, after `"companies.get"` at :47)
- Test: `packages/plugins/sdk/tests/host-client-factory.test.ts` (extend existing suite)

**Interfaces:**
- Produces RPC methods (exact wire contract):
  - `"companies.setStanding": [params: { companyId: string; status: "active" | "grace" | "blocked"; reason: string; message: string; actionUrl?: string }, result: void]`
  - `"companies.clearStanding": [params: { companyId: string }, result: void]`
- Produces SDK surface: `ctx.companies.setStanding(companyId: string, input: { status: "active" | "grace" | "blocked"; reason: string; message: string; actionUrl?: string }): Promise<void>` and `ctx.companies.clearStanding(companyId: string): Promise<void>`.
- Both methods require capability `company.standing.write`; `gated()` (`host-client-factory.ts:659-668`) additionally enforces the invocation company scope because `params.companyId` is present (`requestedCompanyScope`, :539-560).
- Consumed by: Task 5 (server implements `HostServices.companies.setStanding/clearStanding`). Note: `HostClientHandlers` is a complete map over `WorkerToHostMethodName` (:345-348), so adding protocol methods without handlers is a compile error — this task adds both.

**Steps:**

- [ ] Extend `packages/plugins/sdk/tests/host-client-factory.test.ts` with a new describe block at the end of the file:

```ts
describe("createHostClientHandlers company standing", () => {
  it("denies companies.setStanding without company.standing.write", async () => {
    const setStanding = vi.fn(async () => undefined);
    const services = {
      companies: { setStanding },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.billing",
      capabilities: ["companies.read"],
      services,
    });

    await expect(
      handlers["companies.setStanding"](
        {
          companyId: "company-a",
          status: "blocked",
          reason: "subscription_lapsed",
          message: "Subscription lapsed.",
        },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(setStanding).not.toHaveBeenCalled();
  });

  it("delegates setStanding/clearStanding inside the invocation company scope", async () => {
    const setStanding = vi.fn(async () => undefined);
    const clearStanding = vi.fn(async () => undefined);
    const services = {
      companies: { setStanding, clearStanding },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.billing",
      capabilities: ["company.standing.write"],
      services,
    });
    const context = { invocationScope: { companyId: "company-a" } };

    await expect(
      handlers["companies.setStanding"](
        {
          companyId: "company-a",
          status: "grace",
          reason: "payment_failed",
          message: "Payment failed.",
          actionUrl: "/billing",
        },
        context,
      ),
    ).resolves.toBeUndefined();
    await expect(
      handlers["companies.clearStanding"]({ companyId: "company-a" }, context),
    ).resolves.toBeUndefined();

    expect(setStanding).toHaveBeenCalledWith(
      {
        companyId: "company-a",
        status: "grace",
        reason: "payment_failed",
        message: "Payment failed.",
        actionUrl: "/billing",
      },
      context,
    );
    expect(clearStanding).toHaveBeenCalledWith({ companyId: "company-a" }, context);
  });

  it("rejects standing writes outside the invocation company scope", async () => {
    const setStanding = vi.fn(async () => undefined);
    const services = {
      companies: { setStanding },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.billing",
      capabilities: ["company.standing.write"],
      services,
    });

    await expect(
      handlers["companies.setStanding"](
        {
          companyId: "company-b",
          status: "blocked",
          reason: "subscription_lapsed",
          message: "Subscription lapsed.",
        },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(setStanding).not.toHaveBeenCalled();
  });
});
```

- [ ] Run it — expected failure: `pnpm --filter @paperclipai/plugin-sdk exec vitest run tests/host-client-factory.test.ts` fails to compile (`"companies.setStanding"` is not a `WorkerToHostMethodName`).
- [ ] In `packages/plugins/sdk/src/protocol.ts`, insert after the `"companies.get"` entry (:1155-1158):

```ts
  "companies.setStanding": [
    params: {
      companyId: string;
      status: "active" | "grace" | "blocked";
      reason: string;
      message: string;
      actionUrl?: string;
    },
    result: void,
  ];
  "companies.clearStanding": [
    params: { companyId: string },
    result: void,
  ];
```

- [ ] In `packages/plugins/sdk/src/host-client-factory.ts`:
  - Update the `companies` group of `HostServices` (:185-189) to:

```ts
  /** Provides `companies.list`, `companies.get`, `companies.setStanding`, `companies.clearStanding`. */
  companies: {
    list(params: WorkerToHostMethods["companies.list"][0]): Promise<WorkerToHostMethods["companies.list"][1]>;
    get(params: WorkerToHostMethods["companies.get"][0]): Promise<WorkerToHostMethods["companies.get"][1]>;
    setStanding(params: WorkerToHostMethods["companies.setStanding"][0], context?: WorkerHostCallContext): Promise<void>;
    clearStanding(params: WorkerToHostMethods["companies.clearStanding"][0], context?: WorkerHostCallContext): Promise<void>;
  };
```

  - In `METHOD_CAPABILITY_MAP`, after `"companies.get": "companies.read",` (:410), add:

```ts
  "companies.setStanding": "company.standing.write",
  "companies.clearStanding": "company.standing.write",
```

  - In the returned handler map, after the `"companies.get"` handler (:780-782), add:

```ts
    "companies.setStanding": gated("companies.setStanding", async (params, context) => {
      return services.companies.setStanding(params, context);
    }),
    "companies.clearStanding": gated("companies.clearStanding", async (params, context) => {
      return services.companies.clearStanding(params, context);
    }),
```

- [ ] In `packages/plugins/sdk/src/types.ts`, extend `PluginCompaniesClient` (:1071-1081) — replace the interface with:

```ts
export interface PluginCompaniesClient {
  /**
   * List companies visible to this plugin.
   */
  list(input?: { limit?: number; offset?: number }): Promise<Company[]>;

  /**
   * Get one company by ID.
   */
  get(companyId: string): Promise<Company | null>;

  /**
   * Declare the calling plugin's standing for a company (spec §5).
   *
   * `blocked` stops new agent runs for the company at the run-start gate;
   * `grace` only warns; `active` (or clearing) removes the plugin's verdict.
   * Rows are always scoped to the calling plugin — other plugins' standings
   * are unaffected, and the effective standing is the most severe row.
   *
   * Requires the `company.standing.write` capability.
   */
  setStanding(
    companyId: string,
    input: {
      status: "active" | "grace" | "blocked";
      /** Short machine code, e.g. `"subscription_lapsed"`. */
      reason: string;
      /** Human text shown in banners and run-start errors. */
      message: string;
      /** Optional deep link, e.g. the billing page. */
      actionUrl?: string;
    },
  ): Promise<void>;

  /**
   * Remove the calling plugin's standing row for a company (idempotent).
   *
   * Requires the `company.standing.write` capability.
   */
  clearStanding(companyId: string): Promise<void>;
}
```

- [ ] In `packages/plugins/sdk/src/worker-rpc-host.ts`, extend the `companies` block (:742-753) — after the `get` method, add:

```ts
        async setStanding(companyId: string, input) {
          return callHost("companies.setStanding", {
            companyId,
            status: input.status,
            reason: input.reason,
            message: input.message,
            actionUrl: input.actionUrl,
          });
        },

        async clearStanding(companyId: string) {
          return callHost("companies.clearStanding", { companyId });
        },
```

- [ ] In `server/src/services/plugin-capability-validator.ts`, in `OPERATION_CAPABILITIES` after `"companies.get": ["companies.read"],` (:47), add:

```ts
  "companies.setStanding": ["company.standing.write"],
  "companies.clearStanding": ["company.standing.write"],
```

  (This keeps the server-side operation map — used by `plugin-runtime-sandbox.ts:62` — in sync with the SDK bridge map; unknown operations are rejected by default.)
- [ ] Run again — expected pass: `pnpm --filter @paperclipai/plugin-sdk exec vitest run tests/host-client-factory.test.ts` (existing + 3 new tests green). Note: this task leaves `server` typechecking broken until Task 5 implements the new `HostServices.companies` members — that is expected mid-stack; Task 5 lands in the next commit before any full-repo verify.
- [ ] Commit:

```bash
git add packages/plugins/sdk/src/protocol.ts packages/plugins/sdk/src/host-client-factory.ts packages/plugins/sdk/src/worker-rpc-host.ts packages/plugins/sdk/src/types.ts packages/plugins/sdk/tests/host-client-factory.test.ts server/src/services/plugin-capability-validator.ts
git commit -m "feat(plugin-sdk): add ctx.companies.setStanding/clearStanding gated on company.standing.write

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Host-services implementation — plugin-scoped standing writes

**Files:**
- Modify: `server/src/services/plugin-host-services.ts` (imports header ~:31; service instantiations in `buildHostServices` :498-546; `companies` namespace :1337-1345)
- Test: `server/src/__tests__/company-standing-host-services.test.ts` (new; `buildHostServices` embedded-postgres pattern from `server/src/__tests__/plugin-orchestration-apis.test.ts` — event-bus stub at :31-35, calls like `buildHostServices(db, "plugin-record-id", "paperclip.workspace", createEventBusStub())` at :149)

**Interfaces:**
- Consumes: `companyStandingService` (Task 3), `WorkerToHostMethods["companies.setStanding"|"companies.clearStanding"]` param shapes (Task 4).
- Produces: `HostServices.companies.setStanding/clearStanding` with `pluginId` injected from the `buildHostServices(db, pluginId, ...)` closure (`plugin-host-services.ts:490-497`) — the worker can never name another plugin.

**Steps:**

- [ ] Write the failing test `server/src/__tests__/company-standing-host-services.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyStanding, createDb, plugins } from "@paperclipai/db";
import type { PluginEventBus } from "../services/plugin-event-bus.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { companyStandingService } from "../services/company-standing.ts";
import {
  closeDbClient,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Mirrors the stub in plugin-orchestration-apis.test.ts:31-40 exactly.
function createEventBusStub(): PluginEventBus {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as unknown as PluginEventBus;
}

describeEmbeddedPostgres("host services company standing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-standing-host-services-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyStanding);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function insertFixture() {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Host Services Co",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.billing",
      packageName: "@paperclipai/plugin-billing",
      version: "1.0.0",
      manifestJson: {
        id: "paperclip.billing",
        name: "Billing",
        version: "1.0.0",
        capabilities: ["company.standing.write"],
      } as never,
      status: "ready",
    });
    return { companyId, pluginId };
  }

  it("writes standing rows scoped to the host-injected pluginId", async () => {
    const { companyId, pluginId } = await insertFixture();
    const services = buildHostServices(db, pluginId, "paperclip.billing", createEventBusStub());

    await services.companies.setStanding({
      companyId,
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Subscription lapsed.",
      actionUrl: "/billing",
    });

    const rows = await db.select().from(companyStanding);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      pluginId,
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Subscription lapsed.",
      actionUrl: "/billing",
    });

    const standings = companyStandingService(db);
    await expect(standings.getEffectiveStanding(companyId)).resolves.toMatchObject({
      status: "blocked",
      actionUrl: "/billing",
    });

    services.dispose();
  });

  it("clearStanding removes the plugin's row", async () => {
    const { companyId, pluginId } = await insertFixture();
    const services = buildHostServices(db, pluginId, "paperclip.billing", createEventBusStub());

    await services.companies.setStanding({
      companyId,
      status: "grace",
      reason: "payment_failed",
      message: "Payment failed.",
    });
    await services.companies.clearStanding({ companyId });

    await expect(db.select().from(companyStanding)).resolves.toHaveLength(0);
    services.dispose();
  });
});
```

- [ ] Run it — expected failure: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/company-standing-host-services.test.ts` — type/property error: `services.companies.setStanding is not a function` (the `HostServices` interface from Task 4 requires it, so the server package also fails `tsc` until this task completes).
- [ ] In `server/src/services/plugin-host-services.ts`:
  - Add the import after `import { companyService } from "./companies.js";` (:31):

```ts
import { companyStandingService } from "./company-standing.js";
```

  - In `buildHostServices`, after `const companies = companyService(db);` (:502), add:

```ts
  const companyStandings = companyStandingService(db);
```

  - Extend the `companies` namespace (:1337-1345): keep the existing `list`/`get` bodies exactly as they are and insert the two new methods after `get` (before the closing `},` of the `companies` group):

```ts
      async setStanding(params) {
        await ensurePluginAvailableForCompany(params.companyId);
        // pluginId comes from the host-side closure, never from the worker:
        // a plugin can only ever write its own standing rows (spec §5.2).
        await companyStandings.setStanding(pluginId, params.companyId, {
          status: params.status,
          reason: params.reason,
          message: params.message,
          actionUrl: params.actionUrl,
        });
      },
      async clearStanding(params) {
        await ensurePluginAvailableForCompany(params.companyId);
        await companyStandings.clearStanding(pluginId, params.companyId);
      },
```

  (`ensurePluginAvailableForCompany` is the existing per-company availability hook at :593 — a no-op today; PR-2 turns it into the real enablement gate, which these methods then inherit for free.)
- [ ] Run again — expected pass: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/company-standing-host-services.test.ts` (2 passing). Also run `pnpm --filter @paperclipai/plugin-sdk exec vitest run tests/host-client-factory.test.ts` to confirm the SDK suite still passes.
- [ ] Commit:

```bash
git add server/src/services/plugin-host-services.ts server/src/__tests__/company-standing-host-services.test.ts
git commit -m "feat(server): implement plugin-scoped company standing host services

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Cleanup — uninstall / instance-disable / company-disable delete standing rows

**Files:**
- Modify: `server/src/services/plugin-lifecycle.ts` (imports :38-49; factory body — `const registry = pluginRegistryService(db);` at ~:322; `disable()` :512-532; `unload()` :535-588)
- Modify: `server/src/services/plugin-registry.ts` (imports :1-20; `upsertCompanySettings` :408-450)
- Test: `server/src/__tests__/company-standing-cleanup.test.ts` (new; embedded-postgres)

**Interfaces:**
- Consumes: `companyStandingService.clearAllForPlugin` / `.clearStanding` (Task 3).
- Cleanup sites (spec §5.2 "uninstalling a plugin, instance-disabling it, or company-disabling it"):
  1. **Instance-disable:** `PluginLifecycleManager.disable()` (`ready` → `disabled`, the only disable path — routes call `lifecycle.disable` at `server/src/routes/plugins.ts:1999-2018`).
  2. **Uninstall:** `PluginLifecycleManager.unload()` (any → `uninstalled`; the hard-delete path also cascades via the `plugin_id` FK, the soft path needs the explicit delete).
  3. **Company-disable:** `pluginRegistryService.upsertCompanySettings(pluginId, companyId, { enabled: false, ... })` — the only write path for `plugin_company_settings.enabled` today, and the path PR-2's enablement route will call.

**Steps:**

- [ ] Write the failing test `server/src/__tests__/company-standing-cleanup.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyStanding,
  createDb,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { companyStandingService } from "../services/company-standing.ts";
import {
  closeDbClient,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company standing cleanup on plugin lifecycle transitions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-standing-cleanup-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyStanding);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function insertFixture() {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const pluginId = randomUUID();
    for (const [companyId, name] of [
      [companyA, "Cleanup Co A"],
      [companyB, "Cleanup Co B"],
    ] as const) {
      await db.insert(companies).values({
        id: companyId,
        name,
        issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.billing",
      packageName: "@paperclipai/plugin-billing",
      version: "1.0.0",
      manifestJson: {
        id: "paperclip.billing",
        name: "Billing",
        version: "1.0.0",
        capabilities: ["company.standing.write"],
      } as never,
      status: "ready",
    });
    const standings = companyStandingService(db);
    await standings.setStanding(pluginId, companyA, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Lapsed.",
    });
    await standings.setStanding(pluginId, companyB, {
      status: "grace",
      reason: "payment_failed",
      message: "Failed.",
    });
    return { companyA, companyB, pluginId };
  }

  it("instance-disable deletes all of the plugin's standing rows", async () => {
    const { pluginId } = await insertFixture();
    const lifecycle = pluginLifecycleManager(db);

    await lifecycle.disable(pluginId, "operator action");

    await expect(db.select().from(companyStanding)).resolves.toHaveLength(0);
  });

  it("uninstall (soft) deletes all of the plugin's standing rows", async () => {
    const { pluginId } = await insertFixture();
    const lifecycle = pluginLifecycleManager(db);

    await lifecycle.unload(pluginId, false);

    await expect(db.select().from(companyStanding)).resolves.toHaveLength(0);
  });

  it("company-disable deletes only that company's row for the plugin", async () => {
    const { companyA, companyB, pluginId } = await insertFixture();
    const registry = pluginRegistryService(db);

    await registry.upsertCompanySettings(pluginId, companyA, {
      enabled: false,
      settingsJson: {},
    });

    const rows = await db.select().from(companyStanding);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: companyB, pluginId });
  });

  it("company re-enable does not touch standing rows", async () => {
    const { companyA, pluginId } = await insertFixture();
    const registry = pluginRegistryService(db);

    await registry.upsertCompanySettings(pluginId, companyA, {
      enabled: true,
      settingsJson: {},
    });

    await expect(db.select().from(companyStanding)).resolves.toHaveLength(2);
  });
});
```

- [ ] Run it — expected failure: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/company-standing-cleanup.test.ts` — the disable/unload/company-disable tests fail with standing rows still present (cleanup not wired).
- [ ] In `server/src/services/plugin-lifecycle.ts`:
  - Add import after `import { pluginRegistryService } from "./plugin-registry.js";` (:45):

```ts
import { companyStandingService } from "./company-standing.js";
```

  - In the factory body, after `const registry = pluginRegistryService(db);` (~:322), add:

```ts
  const companyStandings = companyStandingService(db);
```

  - In `disable()` (:512-532), after `const result = await transition(pluginId, "disabled", reason ?? null, plugin);` and before `emitDomain("plugin.disabled", ...)`, add:

```ts
      // A disabled governance plugin must never leave companies stranded:
      // drop every standing row it has written (spec §5.2). Fail-safe —
      // missing rows simply mean "active".
      await companyStandings.clearAllForPlugin(pluginId);
```

  - In `unload()` (:535-588), immediately before `const result = await registry.uninstall(pluginId, removeData);` (:567), add:

```ts
      // Uninstall cleanup (spec §5.2). The hard-delete path also cascades via
      // the company_standing.plugin_id FK; the soft path needs this explicit
      // delete because the plugin row survives with status "uninstalled".
      await companyStandings.clearAllForPlugin(pluginId);
```

    Also add the same call in the already-uninstalled hard-delete branch (:542-556), before `const deleted = await registry.uninstall(pluginId, true);` (defensive — rows should already be gone from the earlier soft unload).
- [ ] In `server/src/services/plugin-registry.ts`:
  - Add `companyStanding` to the `@paperclipai/db` table imports at the top of the file (the import list that already contains `pluginCompanySettings` at :6).
  - In `upsertCompanySettings` (:408-450), in the `existing` branch, capture the returned row and delete standings when the write disables the plugin for the company. Replace the `if (existing) { return db.update(...) ... }` body with:

```ts
      if (existing) {
        const updated = await db
          .update(pluginCompanySettings)
          .set({
            enabled: input.enabled ?? existing.enabled,
            settingsJson: input.settingsJson,
            lastError: input.lastError ?? null,
            updatedAt: new Date(),
          })
          .where(eq(pluginCompanySettings.id, existing.id))
          .returning()
          .then((rows) => rows[0]) as PluginCompanySettings;
        if (input.enabled === false) {
          // Company-disable cleanup (spec §5.2): the plugin loses its verdict
          // for this company; other companies' rows are untouched.
          await db
            .delete(companyStanding)
            .where(and(
              eq(companyStanding.pluginId, pluginId),
              eq(companyStanding.companyId, companyId),
            ));
        }
        return updated;
      }
```

    And in the insert branch (no existing row), after the insert resolves, add the same conditional delete when `input.enabled === false` — i.e. change the tail of the function to:

```ts
      const created = await db
        .insert(pluginCompanySettings)
        .values({
          pluginId,
          companyId,
          enabled: input.enabled ?? true,
          settingsJson: input.settingsJson,
          lastError: input.lastError ?? null,
        })
        .returning()
        .then((rows) => rows[0]) as PluginCompanySettings;
      if (input.enabled === false) {
        await db
          .delete(companyStanding)
          .where(and(
            eq(companyStanding.pluginId, pluginId),
            eq(companyStanding.companyId, companyId),
          ));
      }
      return created;
```

    (`and`/`eq` are already imported in this file — see :402.)
- [ ] Run again — expected pass: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/company-standing-cleanup.test.ts` (4 passing).
- [ ] Regression: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/plugin-orchestration-apis.test.ts` still green (lifecycle/registry signatures unchanged).
- [ ] Commit:

```bash
git add server/src/services/plugin-lifecycle.ts server/src/services/plugin-registry.ts server/src/__tests__/company-standing-cleanup.test.ts
git commit -m "feat(server): delete company standing rows on plugin uninstall/disable/company-disable

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Run-start enforcement — `company_blocked` beside the budget hard-stop

**Files:**
- Modify: `server/src/services/heartbeat.ts` (imports — add next to `import { budgetService, ... }` at :96; factory — after `const budgets = budgetService(db, budgetHooks);` at :5470; gate — inside `enqueueWakeup` (:14907), immediately after the budget block at :15098-15108)
- Test: `server/src/__tests__/heartbeat-company-standing-gate.test.ts` (new; pattern from `server/src/__tests__/heartbeat-archived-company-guard.test.ts`)

**Interfaces:**
- Consumes: `companyStandingService.getEffectiveStanding` (Task 3), `conflict` (already imported in heartbeat.ts at :69), the existing `writeSkippedRequest` helper in `enqueueWakeup` scope (:14930-14947).
- Produces: typed error — `HttpError` status 409, `message` = the standing's human message, `details = { code: "company_blocked", reason, actionUrl }`. `grace` and `active` proceed untouched. This single check covers every run start because ALL wakeups (timers, on-demand, automation, retries promoting to wakes) funnel through `enqueueWakeup`, exactly like the budget hard-stop beside it.

**Steps:**

- [ ] Write the failing test `server/src/__tests__/heartbeat-company-standing-gate.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyStanding,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  plugins,
} from "@paperclipai/db";
import {
  closeDbClient,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { companyStandingService } from "../services/company-standing.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company-standing gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat company-standing run-start gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const heartbeats: Array<ReturnType<typeof heartbeatService>> = [];

  function makeHeartbeat(...args: Parameters<typeof heartbeatService>) {
    const heartbeat = heartbeatService(...args);
    heartbeats.push(heartbeat);
    return heartbeat;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-company-standing-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    while (heartbeats.length > 0) {
      await heartbeats.pop()?.drain();
    }
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(companyStanding);
    await db.delete(plugins);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function insertFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pluginId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Standing Gate Co",
      status: "active",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      // Every successful-wakeup fixture in this suite family sets this (see
      // heartbeat-accepted-plan-workspace-refresh.test.ts:300-305) so run
      // seeding never trips the responsible_user_unresolved 422.
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Gate Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.billing",
      packageName: "@paperclipai/plugin-billing",
      version: "1.0.0",
      manifestJson: {
        id: "paperclip.billing",
        name: "Billing",
        version: "1.0.0",
        capabilities: ["company.standing.write"],
      } as never,
      status: "ready",
    });

    return { companyId, agentId, pluginId };
  }

  it("refuses new runs with typed company_blocked when effectively blocked", async () => {
    const { companyId, agentId, pluginId } = await insertFixture();
    await companyStandingService(db).setStanding(pluginId, companyId, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Your subscription has lapsed.",
      actionUrl: "/billing",
    });

    const heartbeat = makeHeartbeat(db);

    await expect(heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      message: "Your subscription has lapsed.",
      details: {
        code: "company_blocked",
        reason: "subscription_lapsed",
        actionUrl: "/billing",
      },
    });

    const runCount = await db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.agentId === agentId).length);
    expect(runCount).toBe(0);

    // The refusal is recorded as a skipped wakeup request, like budget blocks.
    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .then((rows) => rows.filter((row) => row.agentId === agentId && row.status === "skipped"));
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]).toMatchObject({ reason: "company.standing_blocked" });
  });

  it("grace never blocks: runs proceed", async () => {
    const { companyId, agentId, pluginId } = await insertFixture();
    await companyStandingService(db).setStanding(pluginId, companyId, {
      status: "grace",
      reason: "payment_failed",
      message: "Your last payment failed.",
    });

    const heartbeat = makeHeartbeat(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    expect(run).toBeTruthy();
  });

  it("no standing rows: runs proceed (fail-safe active)", async () => {
    const { agentId } = await insertFixture();

    const heartbeat = makeHeartbeat(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    expect(run).toBeTruthy();
  });
});
```

- [ ] Run it — expected failure: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/heartbeat-company-standing-gate.test.ts` — the blocked test fails: `wakeup` resolves with a run instead of rejecting.
- [ ] In `server/src/services/heartbeat.ts`:
  - Add import next to `import { budgetService, type BudgetEnforcementScope } from "./budgets.js";` (:96):

```ts
import { companyStandingService } from "./company-standing.js";
```

  - In the service factory, after `const budgets = budgetService(db, budgetHooks);` (:5470), add:

```ts
  const companyStandings = companyStandingService(db);
```

  - In `enqueueWakeup`, immediately after the budget hard-stop block (:15102-15108, `if (budgetBlock) { ... throw conflict(...); }`), add:

```ts
    // Company-standing gate (spec §5.3): one check beside the budget
    // hard-stop. Only an explicit persisted `blocked` row refuses new work;
    // `grace` never blocks and unknown/unwritten standing means active.
    const standing = await companyStandings.getEffectiveStanding(agent.companyId);
    if (standing.status === "blocked") {
      await writeSkippedRequest("company.standing_blocked");
      throw conflict(standing.message ?? "This company is blocked from starting new work.", {
        code: "company_blocked",
        reason: standing.reason ?? null,
        actionUrl: standing.actionUrl ?? null,
      });
    }
```

- [ ] Run again — expected pass: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/heartbeat-company-standing-gate.test.ts` (3 passing).
- [ ] Regression: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/heartbeat-archived-company-guard.test.ts` still green (gate ordering unchanged for existing paths).
- [ ] Commit:

```bash
git add server/src/services/heartbeat.ts server/src/__tests__/heartbeat-company-standing-gate.test.ts
git commit -m "feat(server): refuse run starts with typed company_blocked when standing is blocked

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: `/cli-auth/me` — `capabilities.companyStandings` payload

**Files:**
- Modify: `server/src/routes/access.ts` (services import block :66-74; `accessRoutes` factory — after `const boardAuth = boardAuthService(db);` at :2621; `/cli-auth/me` handler :2853-2868)
- Test: `server/src/__tests__/cli-auth-routes.test.ts` (extend existing suite — its `vi.mock("../services/index.js", ...)` factories at :31-38 and :43-51 must both gain the new export or every test in the file breaks on import)

**Interfaces:**
- Consumes: `companyStandingService` via the `../services/index.js` barrel (Task 3 exported it there — required so the existing route-test mocking strategy keeps working).
- Produces: `GET /cli-auth/me` response gains `capabilities: { companyStandings: Record<string, EffectiveStanding> }` computed from `getEffectiveStandings(accessSnapshot.companyIds)`. **PR-1 coupling:** when PR-1's capabilities builder exists, move `companyStandings` into it (Global Constraint 4).

**Steps:**

- [ ] Extend `server/src/__tests__/cli-auth-routes.test.ts`:
  - Add a hoisted mock next to the existing ones (:5-27):

```ts
const mockCompanyStandingService = vi.hoisted(() => ({
  getEffectiveStandings: vi.fn(),
}));
```

  - Add `companyStandingService: () => mockCompanyStandingService,` to BOTH `vi.mock("../services/index.js", ...)` factory objects (the top-level one at :31-38 and the one inside `registerModuleMocks()` at :43-51), each directly after `boardAuthService: () => mockBoardAuthService,`.
  - In the existing `beforeEach`, after `registerModuleMocks();`, add a default:

```ts
    mockCompanyStandingService.getEffectiveStandings.mockResolvedValue({});
```

  - Add a new test inside the `describe.sequential("cli auth routes", ...)` block (mirror the file's existing `/cli-auth/me` test for actor/`resolveBoardAccess` shapes — if none exists, this is the first):

```ts
  it("GET /cli-auth/me returns capabilities.companyStandings for the actor's companies", async () => {
    const userId = "user-1";
    mockBoardAuthService.resolveBoardAccess.mockResolvedValue({
      user: { id: userId, email: "owner@example.com", name: "Owner", image: null },
      isInstanceAdmin: false,
      companyIds: ["company-a", "company-b"],
      memberships: [],
    });
    mockCompanyStandingService.getEffectiveStandings.mockResolvedValue({
      "company-a": { status: "active" },
      "company-b": {
        status: "blocked",
        reason: "subscription_lapsed",
        message: "Subscription lapsed.",
        actionUrl: "/billing",
      },
    });

    const app = await createApp({ type: "board", userId, source: "session" });
    const res = await request(app).get("/api/cli-auth/me");

    expect(res.status).toBe(200);
    expect(mockCompanyStandingService.getEffectiveStandings).toHaveBeenCalledWith([
      "company-a",
      "company-b",
    ]);
    expect(res.body.capabilities).toEqual({
      companyStandings: {
        "company-a": { status: "active" },
        "company-b": {
          status: "blocked",
          reason: "subscription_lapsed",
          message: "Subscription lapsed.",
          actionUrl: "/billing",
        },
      },
    });
  });
```

- [ ] Run it — expected failure: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/cli-auth-routes.test.ts` — the new test fails (`res.body.capabilities` is `undefined`); pre-existing tests still pass (the added mock export is inert for them).
- [ ] In `server/src/routes/access.ts`:
  - Add `companyStandingService,` to the import list from `"../services/index.js"` (:66-74), alphabetically after `boardAuthService,`.
  - In `accessRoutes`, after `const boardAuth = boardAuthService(db);` (:2621), add:

```ts
  const companyStandings = companyStandingService(db);
```

  - Replace the `/cli-auth/me` handler body (:2853-2868) with:

```ts
  router.get("/cli-auth/me", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const accessSnapshot = await boardAuth.resolveBoardAccess(req.actor.userId);
    const standings = await companyStandings.getEffectiveStandings(accessSnapshot.companyIds);
    res.json({
      user: accessSnapshot.user,
      userId: req.actor.userId,
      isInstanceAdmin: accessSnapshot.isInstanceAdmin,
      companyIds: accessSnapshot.companyIds,
      memberships: accessSnapshot.memberships,
      source: req.actor.source ?? "none",
      keyId: req.actor.source === "board_key" ? req.actor.keyId ?? null : null,
      cloudStack: req.actor.source === "cloud_tenant" ? req.actor.cloudStack ?? null : null,
      // PR-3: effective standings ride the capabilities payload (spec §5.4).
      // PR-1 introduces the full capabilities object (exposedSurfaces,
      // features); on rebase, fold companyStandings into it.
      capabilities: {
        companyStandings: standings,
      },
    });
  });
```

- [ ] Run again — expected pass: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/cli-auth-routes.test.ts` (all tests green, including pre-existing ones).
- [ ] Commit:

```bash
git add server/src/routes/access.ts server/src/__tests__/cli-auth-routes.test.ts
git commit -m "feat(server): expose capabilities.companyStandings on GET /cli-auth/me

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: UI — standing types + layout banner (grace = warning, blocked = error + action link)

**Files:**
- Modify: `ui/src/api/access.ts` (`CurrentBoardAccess` :236-253)
- Create: `ui/src/components/CompanyStandingBanner.tsx`
- Modify: `ui/src/components/Layout.tsx` (import block :19-21; banner stack :556-558 — mount after `<CloudTrialBanner />`)
- Test: `ui/src/components/CompanyStandingBanner.test.tsx` (new; jsdom pattern from `ui/src/components/CompanySwitcher.test.tsx`)

**Interfaces:**
- Consumes: `accessApi.getCurrentBoardAccess()` (`ui/src/api/access.ts:423-424`), query key `queryKeys.access.currentBoardAccess` (`ui/src/lib/queryKeys.ts:299`), `useCompany()` (`ui/src/context/CompanyContext.tsx` — provides `selectedCompanyId`).
- Produces: `CompanyStandingStatus`, `EffectiveCompanyStanding` UI types; `<CompanyStandingBanner />` rendering nothing for `active`/unknown (fail-safe, spec §6: capabilities failures degrade closed for warnings but never block the page — a failed fetch renders nothing).

**Steps:**

- [ ] Write the failing test `ui/src/components/CompanyStandingBanner.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyStandingBanner } from "./CompanyStandingBanner";

const getCurrentBoardAccessMock = vi.hoisted(() => vi.fn());
const useCompanyMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: { getCurrentBoardAccess: () => getCurrentBoardAccessMock() },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => useCompanyMock(),
}));

// Same module-level flag CompanySwitcher.test.tsx sets (:79).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function boardAccess(companyStandings: Record<string, unknown>) {
  return {
    user: null,
    userId: "user-1",
    isInstanceAdmin: false,
    companyIds: Object.keys(companyStandings),
    source: "session",
    keyId: null,
    capabilities: { companyStandings },
  };
}

describe("CompanyStandingBanner", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useCompanyMock.mockReturnValue({ selectedCompanyId: "company-1" });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyStandingBanner />
        </QueryClientProvider>,
      );
    });
    // Let the query resolve (microtasks + a macrotask, like the
    // flushReact helper in CompanySwitcher.test.tsx:82-87).
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  it("renders nothing when the selected company is active", async () => {
    getCurrentBoardAccessMock.mockResolvedValue(
      boardAccess({ "company-1": { status: "active" } }),
    );
    await render();
    expect(container.textContent).toBe("");
  });

  it("renders nothing when standings are missing (fail-safe)", async () => {
    getCurrentBoardAccessMock.mockResolvedValue({
      user: null,
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
    });
    await render();
    expect(container.textContent).toBe("");
  });

  it("renders a warning with action link for grace", async () => {
    getCurrentBoardAccessMock.mockResolvedValue(
      boardAccess({
        "company-1": {
          status: "grace",
          reason: "payment_failed",
          message: "Your last payment failed.",
          actionUrl: "/billing",
        },
      }),
    );
    await render();
    const banner = container.querySelector('[data-testid="company-standing-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("data-standing")).toBe("grace");
    expect(banner!.textContent).toContain("Your last payment failed.");
    const link = banner!.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/billing");
  });

  it("renders an error banner with action link for blocked", async () => {
    getCurrentBoardAccessMock.mockResolvedValue(
      boardAccess({
        "company-1": {
          status: "blocked",
          reason: "subscription_lapsed",
          message: "Your subscription has lapsed. New agent runs are paused.",
          actionUrl: "/billing",
        },
      }),
    );
    await render();
    const banner = container.querySelector('[data-testid="company-standing-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("data-standing")).toBe("blocked");
    expect(banner!.textContent).toContain("New agent runs are paused");
    expect(banner!.querySelector("a")?.getAttribute("href")).toBe("/billing");
  });

  it("renders nothing for a different selected company", async () => {
    useCompanyMock.mockReturnValue({ selectedCompanyId: "company-2" });
    getCurrentBoardAccessMock.mockResolvedValue(
      boardAccess({
        "company-1": { status: "blocked", reason: "x", message: "Blocked." },
      }),
    );
    await render();
    expect(container.textContent).toBe("");
  });
});
```

- [ ] Run it — expected failure: `pnpm --filter @paperclipai/ui exec vitest run src/components/CompanyStandingBanner.test.tsx` fails at import (component does not exist).
- [ ] In `ui/src/api/access.ts`, add above `CurrentBoardAccess` (:236):

```ts
export type CompanyStandingStatus = "active" | "grace" | "blocked";

/** Effective per-company standing merged server-side (blocked > grace > active). */
export type EffectiveCompanyStanding = {
  status: CompanyStandingStatus;
  reason?: string;
  message?: string;
  actionUrl?: string;
};
```

  and add to the `CurrentBoardAccess` type (after the `cloudStack` field):

```ts
  /**
   * Server-computed capabilities payload. PR-3 contributes companyStandings;
   * PR-1 adds exposedSurfaces/features. Optional so older servers degrade to
   * "no warnings" (fail-safe).
   */
  capabilities?: {
    companyStandings?: Record<string, EffectiveCompanyStanding>;
  };
```

- [ ] Create `ui/src/components/CompanyStandingBanner.tsx` (banner style mirrors `CloudTrialBanner.tsx`; no dismiss — a governance verdict must stay visible):

```tsx
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, OctagonX } from "lucide-react";
import { accessApi } from "@/api/access";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

/**
 * Layout-level standing banner for the selected company (spec §5.4):
 * `grace` → warning + action link, `blocked` → error + action link.
 * Renders nothing for `active`, unknown companies, or while/after a failed
 * capabilities fetch — the standing gate is enforced server-side, the banner
 * only warns (fail-safe: unknown = active).
 */
export function CompanyStandingBanner() {
  const { selectedCompanyId } = useCompany();

  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
    staleTime: 60_000,
  });

  const standing = selectedCompanyId
    ? boardAccess?.capabilities?.companyStandings?.[selectedCompanyId]
    : undefined;
  if (!standing || (standing.status !== "grace" && standing.status !== "blocked")) return null;

  const blocked = standing.status === "blocked";
  const Icon = blocked ? OctagonX : AlertTriangle;
  const fallbackMessage = blocked
    ? "This company is blocked from starting new agent runs."
    : "This company needs attention.";

  return (
    <div
      data-testid="company-standing-banner"
      data-standing={standing.status}
      role={blocked ? "alert" : "status"}
      className={
        blocked
          ? "border-b border-red-300/60 bg-red-50 text-red-950 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100"
          : "border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
      }
    >
      <div className="flex items-center gap-3 px-3 py-2 text-sm">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          {standing.message?.trim() || fallbackMessage}
          {standing.actionUrl ? (
            <>
              {" "}
              <a
                href={standing.actionUrl}
                className="font-semibold underline underline-offset-2 hover:opacity-80"
              >
                Resolve now
              </a>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}
```

- [ ] In `ui/src/components/Layout.tsx`:
  - Add the import after `import { CloudTrialBanner } from "./CloudTrialBanner";` (:21):

```ts
import { CompanyStandingBanner } from "./CompanyStandingBanner";
```

  - Mount it in the banner stack after `<CloudTrialBanner />` (:558):

```tsx
      <CloudTrialBanner />
      <CompanyStandingBanner />
```

- [ ] Run again — expected pass: `pnpm --filter @paperclipai/ui exec vitest run src/components/CompanyStandingBanner.test.tsx` (5 passing).
- [ ] Note on spec §5.4 "run-start affordances surface the `company_blocked` message with the action link": no extra plumbing is required. Task 7 sets the `HttpError` `message` to the standing's human message, so every existing run-start affordance (manual invoke, wake buttons) already displays it through the shared `ApiError` toast/error path — and the persistent blocked banner added here carries the action link on every page of the company. Spec §6's "agents receiving it mark work blocked rather than failed-retryable" is likewise satisfied structurally: the gate refuses BEFORE a run exists (a `skipped` wakeup request is recorded, reason `company.standing_blocked`), so nothing enters the failed-retryable machinery — verified by the Task 7 test asserting zero `heartbeat_runs` rows and a skipped `agent_wakeup_requests` row.
- [ ] Commit:

```bash
git add ui/src/api/access.ts ui/src/components/CompanyStandingBanner.tsx ui/src/components/Layout.tsx ui/src/components/CompanyStandingBanner.test.tsx
git commit -m "feat(ui): company standing layout banner from capabilities payload

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: UI — company-switcher standing badges

**Files:**
- Modify: `ui/src/components/CompanySwitcher.tsx` (imports :1-17; component body — add standings query after the `healthQuery` at :49-54; per-company row :78-87)
- Test: `ui/src/components/CompanySwitcher.test.tsx` (extend — the existing file already mocks `CompanyContext`, `@/api/health`, router, and dropdown primitives; it must additionally mock `@/api/access`)

**Interfaces:**
- Consumes: `accessApi.getCurrentBoardAccess()`, `queryKeys.access.currentBoardAccess`, `EffectiveCompanyStanding` (Task 9).
- Produces: per-company badge in the switcher dropdown — `grace` → amber "Attention", `blocked` → red "Blocked" — so an owner with many companies cannot miss a lapsed one (spec §5.4). Fail-safe: no badge when standings are unknown.

**Steps:**

- [ ] Extend `ui/src/components/CompanySwitcher.test.tsx`:
  - Add a hoisted mock next to `healthGetMock` (:13):

```ts
const getCurrentBoardAccessMock = vi.hoisted(() => vi.fn());
```

  - Add the module mock next to the `@/api/health` mock (:30-32):

```ts
vi.mock("@/api/access", () => ({
  accessApi: { getCurrentBoardAccess: () => getCurrentBoardAccessMock() },
}));
```

  - In the EXISTING describe block's `beforeEach` (`"CompanySwitcher — cloud create company"`, :105), add `getCurrentBoardAccessMock.mockResolvedValue({ capabilities: { companyStandings: {} } });` next to the `healthGetMock.mockResolvedValue(...)` line so pre-existing tests keep passing with the new query in flight.
  - Append a NEW describe block at the end of the file, reusing the file's module-level helpers `renderSwitcher(container)` (:88-92, returns `{ root, queryClient }`) and `flushReact()` (:82-87), and the static `CompanyContext` mock (:22-28 — companies list contains `{ id: "company-1", name: "Acme", status: "active" }`):

```tsx
describe("CompanySwitcher — standing badges", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    healthGetMock.mockResolvedValue({ status: "ok", deploymentMode: "local_trusted" });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderWithStandings(companyStandings: Record<string, unknown>) {
    getCurrentBoardAccessMock.mockResolvedValue({ capabilities: { companyStandings } });
    const { root, queryClient } = renderSwitcher(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySwitcher />
        </QueryClientProvider>,
      );
    });
    await flushReact(); // resolve health + board-access queries
    return root;
  }

  it("shows a Blocked badge on companies with blocked standing", async () => {
    const root = await renderWithStandings({
      "company-1": { status: "blocked", reason: "subscription_lapsed", message: "Lapsed." },
    });
    const badge = container.querySelector('[data-testid="company-standing-badge-company-1"]');
    expect(badge?.textContent).toBe("Blocked");
    expect(badge?.getAttribute("data-standing")).toBe("blocked");
    await act(async () => root.unmount());
  });

  it("shows an Attention badge on companies with grace standing", async () => {
    const root = await renderWithStandings({
      "company-1": { status: "grace", reason: "payment_failed", message: "Failed." },
    });
    const badge = container.querySelector('[data-testid="company-standing-badge-company-1"]');
    expect(badge?.textContent).toBe("Attention");
    expect(badge?.getAttribute("data-standing")).toBe("grace");
    await act(async () => root.unmount());
  });

  it("shows no badge for active or unknown standing", async () => {
    const root = await renderWithStandings({ "company-1": { status: "active" } });
    expect(container.querySelector('[data-testid="company-standing-badge-company-1"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
```
- [ ] Run it — expected failure: `pnpm --filter @paperclipai/ui exec vitest run src/components/CompanySwitcher.test.tsx` — new tests fail (no badge elements); pre-existing tests pass (access mock defaulted).
- [ ] In `ui/src/components/CompanySwitcher.tsx`:
  - Add imports: `accessApi` and type `EffectiveCompanyStanding` from `@/api/access`.

```ts
import { accessApi, type EffectiveCompanyStanding } from "@/api/access";
```

  - After the `healthQuery` block (:49-54), add:

```ts
  // Standing badges (spec §5.4): an owner with many companies must not miss a
  // lapsed one. Fail-safe — unknown standings render no badge.
  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
    staleTime: 60_000,
  });
  const companyStandings: Record<string, EffectiveCompanyStanding> =
    boardAccessQuery.data?.capabilities?.companyStandings ?? {};
```

  - Add a small render helper above the component (module scope, beside `statusDotColor`):

```tsx
function StandingBadge({ companyId, standing }: { companyId: string; standing?: EffectiveCompanyStanding }) {
  if (!standing || (standing.status !== "grace" && standing.status !== "blocked")) return null;
  const blocked = standing.status === "blocked";
  return (
    <span
      data-testid={`company-standing-badge-${companyId}`}
      data-standing={standing.status}
      className={
        blocked
          ? "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-200"
          : "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"
      }
    >
      {blocked ? "Blocked" : "Attention"}
    </span>
  );
}
```

  - In the per-company `DropdownMenuItem` (:78-87), after the company-name `<span className="truncate">{company.name}</span>`, add:

```tsx
            <StandingBadge companyId={company.id} standing={companyStandings[company.id]} />
```

- [ ] Run again — expected pass: `pnpm --filter @paperclipai/ui exec vitest run src/components/CompanySwitcher.test.tsx` (existing + 3 new tests green).
- [ ] Commit:

```bash
git add ui/src/components/CompanySwitcher.tsx ui/src/components/CompanySwitcher.test.tsx
git commit -m "feat(ui): company-switcher standing badges (grace/blocked)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: Full verification sweep

**Files:** none new — verification only.

**Steps:**

- [ ] `pnpm typecheck` from repo root — zero errors across all workspace packages (this is where any missed `HostServices` member or export list entry surfaces).
- [ ] Run the PR-3 test set end-to-end on an embedded-postgres-capable host:

```bash
pnpm --filter @paperclipai/shared exec vitest run src/company-standing.test.ts
pnpm --filter @paperclipai/plugin-sdk exec vitest run tests/host-client-factory.test.ts tests/worker-rpc-host.test.ts
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/company-standing-service.test.ts \
  src/__tests__/company-standing-host-services.test.ts \
  src/__tests__/company-standing-cleanup.test.ts \
  src/__tests__/heartbeat-company-standing-gate.test.ts \
  src/__tests__/cli-auth-routes.test.ts \
  src/__tests__/heartbeat-archived-company-guard.test.ts \
  src/__tests__/budgets-service.test.ts \
  src/__tests__/plugin-orchestration-apis.test.ts
pnpm --filter @paperclipai/ui exec vitest run \
  src/components/CompanyStandingBanner.test.tsx \
  src/components/CompanySwitcher.test.tsx
```

- [ ] Confirm `git status` shows no `pnpm-lock.yaml` change and no stray files.
- [ ] Spec §7 PR-3 row coverage check (all four bullets):
  - severity-merge unit tests → Task 3;
  - run-start gate tests (blocked ⇒ typed error, grace ⇒ proceeds) → Task 7;
  - cleanup-on-uninstall/disable tests → Task 6;
  - banner + switcher badge rendering tests → Tasks 9-10.
- [ ] Known flake (do not chase): `heartbeat-process-recovery` has one macOS-flaky test unrelated to this PR.
- [ ] If any UI surface changed visibly and a PR is being opened from this branch: capture and commit screenshots of the banner (grace + blocked) and the switcher badges per repo PR convention.
