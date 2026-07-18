# PR-1: Settings-Surface Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec §3 (PR-1 — settings-surface policy) of `docs/superpowers/specs/2026-07-18-settings-visibility-and-plugin-enablement-design.md`: a shared surface taxonomy, an instance-wide `visibility` policy stored in `instance_settings`, a `capabilities` payload on `GET /cli-auth/me` (exposed surfaces + public feature flags + empty `companyStandings`), server-side `assertSurfaceExposed` enforcement on members/invites/secrets route groups, instance-admin-only reads of `/instance/settings*`, the same-PR UI migration to `capabilities.features`, capabilities-driven nav gating, and the "Company settings visibility" admin card. Default policy = all company surfaces exposed → zero behavior change for self-hosters; `local_trusted` implicit actors and instance admins bypass everything.

**Architecture:** One instance-wide policy (no per-company overrides). Policy lives in a new `visibility` jsonb section of the `instance_settings` singleton row (beside `general`/`experimental`), normalized through a Zod storage schema exactly like the existing sections. The server is authoritative: `assertSurfaceExposed(req, surface, getExposedSurfaces)` in `server/src/routes/authz.ts` throws a typed 403 (`code: "surface_not_exposed"`) for non-admin board actors on hidden surfaces. The UI renders from a server-delivered `capabilities` object on `GET /cli-auth/me` (`CurrentBoardAccess`): `exposedSurfaces` drives company-settings nav, `features` (an explicit allowlist derived from experimental + general settings) replaces all direct non-admin reads of `/instance/settings`, `/instance/settings/general`, `/instance/settings/experimental`, which flip to `assertCanManageInstanceSettings` in the same PR. `companyStandings` is typed now (`EffectiveStanding`) and returns `{}` until PR-3.

**Tech Stack:** TypeScript strict, pnpm workspace, vitest (+ supertest and the embedded-postgres helper for server route tests, jsdom + `createRoot` for UI component tests), Express 4 routes, Drizzle ORM (hand-written SQL migrations — see Global Constraints), Zod 3.24, React + @tanstack/react-query.

## Global Constraints

- Work ONLY in `/Users/jannesstubbemann/repos/paperclip/wt-specs-billing-visibility` (branch `spec/billing-and-settings-visibility`). All paths below are relative to this repo root.
- Strict TDD per task: write the failing test, run it and confirm the expected failure, write the minimal implementation, run again green, then commit. Never commit with a red test in the task's scope.
- Run tests from the owning package directory:
  - shared: `cd packages/shared && pnpm vitest run src/<file>.test.ts`
  - server: `cd server && pnpm vitest run src/__tests__/<file>.test.ts`
  - ui: `cd ui && pnpm vitest run src/<path>.test.tsx`
- Typecheck gate before every commit that touches a package: `pnpm --filter @paperclipai/shared typecheck` (or `cd <pkg> && pnpm typecheck` / `pnpm tsc --noEmit` per package's script). The shared package must build (`cd packages/shared && pnpm build`) before server/ui pick up new exports in vitest runs that resolve `@paperclipai/shared` from `dist` — if imports of new shared symbols fail with "does not provide an export named …", rebuild shared first.
- DB migrations: `drizzle-kit generate` DOES NOT WORK on this fork (the drizzle snapshot chain is forked upstream). Hand-write the SQL file and the `_journal.json` entry exactly as recent migrations 0168–0172 do (no `meta/*_snapshot.json` — recent migrations do not have one). Never renumber existing migrations.
- Do NOT commit `pnpm-lock.yaml`. No dependency changes are expected in this PR.
- Pinned cross-plan contract (other plans depend on these EXACT exported names — do not rename):
  `COMPANY_SETTINGS_SURFACES`, `INSTANCE_SETTINGS_SURFACES`, `CompanySettingsSurface` (packages/shared/src/constants.ts); `InstanceVisibilitySettings` (packages/shared/src/types/instance.ts); Zod validator in packages/shared/src/validators/instance.ts; `capabilities: { exposedSurfaces, features, companyStandings }` on `GET /cli-auth/me` / `CurrentBoardAccess`; `PublicFeatureFlags`; `EffectiveStanding`; `assertSurfaceExposed` exported from server/src/routes/authz.ts; `PATCH /instance/settings/visibility`.
- Every commit message ends with:

  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

- Known-flaky suites unrelated to this PR (do not chase): heartbeat-process-recovery (one test always fails on macOS). Judge success by the tests this plan adds/touches plus package typechecks.

---

## Task 1: Shared surface-taxonomy constants

**Files:**
- Modify: `packages/shared/src/constants.ts` (append at end of file)
- Modify: `packages/shared/src/index.ts` (the `export { … } from "./constants.js";` block that ends at ~line 481)
- Test: `packages/shared/src/settings-surfaces.test.ts` (create)

**Interfaces:**
- Produces:
  - `export const COMPANY_SETTINGS_SURFACES = ["company.general","company.members","company.invites","company.secrets","company.plugins"] as const;`
  - `export type CompanySettingsSurface = (typeof COMPANY_SETTINGS_SURFACES)[number];`
  - `export const INSTANCE_SETTINGS_SURFACES = ["instance.general","instance.environments","instance.access","instance.heartbeats","instance.experimental","instance.plugins","instance.adapters"] as const;`
  - `export type InstanceSettingsSurface = (typeof INSTANCE_SETTINGS_SURFACES)[number];`
- Consumes: nothing (constants.ts is import-free at the top; keep it dependency-free).

**Steps:**

- [ ] Write the failing test `packages/shared/src/settings-surfaces.test.ts` (colocated `*.test.ts` is the shared-package convention, cf. `packages/shared/src/resource-memberships.test.ts`):

  ```ts
  import { describe, expect, it } from "vitest";
  import {
    COMPANY_SETTINGS_SURFACES,
    INSTANCE_SETTINGS_SURFACES,
    type CompanySettingsSurface,
  } from "./constants.js";

  describe("settings-surface taxonomy", () => {
    it("enumerates the company surfaces in canonical order", () => {
      expect(COMPANY_SETTINGS_SURFACES).toEqual([
        "company.general",
        "company.members",
        "company.invites",
        "company.secrets",
        "company.plugins",
      ]);
    });

    it("enumerates the instance surfaces in canonical order", () => {
      expect(INSTANCE_SETTINGS_SURFACES).toEqual([
        "instance.general",
        "instance.environments",
        "instance.access",
        "instance.heartbeats",
        "instance.experimental",
        "instance.plugins",
        "instance.adapters",
      ]);
    });

    it("keeps the namespaces disjoint and prefixed", () => {
      for (const surface of COMPANY_SETTINGS_SURFACES) {
        expect(surface.startsWith("company.")).toBe(true);
      }
      for (const surface of INSTANCE_SETTINGS_SURFACES) {
        expect(surface.startsWith("instance.")).toBe(true);
        expect(COMPANY_SETTINGS_SURFACES as readonly string[]).not.toContain(surface);
      }
    });

    it("type-checks CompanySettingsSurface as the element union", () => {
      const surface: CompanySettingsSurface = "company.members";
      expect(COMPANY_SETTINGS_SURFACES).toContain(surface);
    });
  });
  ```

- [ ] Run it: `cd packages/shared && pnpm vitest run src/settings-surfaces.test.ts` — expected failure: `SyntaxError: The requested module './constants.js' does not provide an export named 'COMPANY_SETTINGS_SURFACES'`.
- [ ] Append to the END of `packages/shared/src/constants.ts`:

  ```ts
  // --- Settings-surface taxonomy (settings-surface policy, PR-1) ---
  //
  // Company-scoped surfaces are exposable to non-admin company members via the
  // instance visibility policy (instance_settings.visibility.companySurfaces).
  // "company.plugins" gates the plugin catalog page ONLY (introduced by PR-2):
  // companySettingsPages of already-enabled plugins render regardless.
  export const COMPANY_SETTINGS_SURFACES = [
    "company.general",
    "company.members",
    "company.invites",
    "company.secrets",
    "company.plugins",
  ] as const;
  export type CompanySettingsSurface = (typeof COMPANY_SETTINGS_SURFACES)[number];

  // Instance-scoped surfaces are NEVER exposable to non-admins and do not
  // appear in the policy at all. Sandboxing (executionMode) lives in
  // "instance.general", so it is structurally invisible to company owners.
  export const INSTANCE_SETTINGS_SURFACES = [
    "instance.general",
    "instance.environments",
    "instance.access",
    "instance.heartbeats",
    "instance.experimental",
    "instance.plugins",
    "instance.adapters",
  ] as const;
  export type InstanceSettingsSurface = (typeof INSTANCE_SETTINGS_SURFACES)[number];
  ```

- [ ] In `packages/shared/src/index.ts`, find the export block that ends with `} from "./constants.js";` (around line 481) and add four entries anywhere inside it:

  ```ts
    COMPANY_SETTINGS_SURFACES,
    INSTANCE_SETTINGS_SURFACES,
    type CompanySettingsSurface,
    type InstanceSettingsSurface,
  ```

- [ ] Run: `cd packages/shared && pnpm vitest run src/settings-surfaces.test.ts` — expected: 4 passed.
- [ ] Run: `cd packages/shared && pnpm typecheck && pnpm build` — expected: clean.
- [ ] Commit:

  ```
  git add packages/shared/src/constants.ts packages/shared/src/index.ts packages/shared/src/settings-surfaces.test.ts
  git commit -m "feat(shared): add settings-surface taxonomy constants

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 2: `InstanceVisibilitySettings` type + Zod validators

**Files:**
- Modify: `packages/shared/src/types/instance.ts` (imports at line 1; `InstanceSettings` interface at lines 91–98)
- Modify: `packages/shared/src/validators/instance.ts` (imports at lines 1–12; `instanceSettingsSchema` at lines 106–113; type exports at lines 97–104)
- Modify: `packages/shared/src/types/index.ts` (instance type block at ~lines 42–50; instance value block at ~lines 66–75)
- Modify: `packages/shared/src/validators/index.ts` (instance block at lines 1–15)
- Modify: `packages/shared/src/index.ts` (root re-export blocks: types block containing `InstanceSettings` at ~line 632; constants-from-types block ending `} from "./types/instance.js";` at ~line 1305; validators block at ~lines 1347–1376)
- Test: `packages/shared/src/validators/instance-visibility.test.ts` (create)

**Interfaces:**
- Consumes: `COMPANY_SETTINGS_SURFACES`, `CompanySettingsSurface` from `../constants.js` (Task 1). Verified: `packages/shared/src/constants.ts` imports nothing from `types/`, so no cycle.
- Produces:
  - `export interface InstanceVisibilitySettings { companySurfaces: CompanySettingsSurface[] }` (types/instance.ts)
  - `export const DEFAULT_INSTANCE_VISIBILITY_SETTINGS: InstanceVisibilitySettings` (types/instance.ts)
  - `InstanceSettings` gains `visibility: InstanceVisibilitySettings;`
  - `export const instanceVisibilitySettingsSchema` , `export const patchInstanceVisibilitySettingsSchema`, `export type PatchInstanceVisibilitySettings` (validators/instance.ts)

**Steps:**

- [ ] Write the failing test `packages/shared/src/validators/instance-visibility.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";
  import { COMPANY_SETTINGS_SURFACES } from "../constants.js";
  import {
    instanceVisibilitySettingsSchema,
    patchInstanceVisibilitySettingsSchema,
  } from "./instance.js";

  describe("instance visibility validators", () => {
    it("defaults companySurfaces to ALL company surfaces (self-hoster parity)", () => {
      expect(instanceVisibilitySettingsSchema.parse({})).toEqual({
        companySurfaces: [...COMPANY_SETTINGS_SURFACES],
      });
    });

    it("accepts an explicit subset", () => {
      expect(
        instanceVisibilitySettingsSchema.parse({
          companySurfaces: ["company.members", "company.general"],
        }),
      ).toEqual({ companySurfaces: ["company.members", "company.general"] });
    });

    it("accepts an explicit empty list (everything hidden)", () => {
      expect(instanceVisibilitySettingsSchema.parse({ companySurfaces: [] })).toEqual({
        companySurfaces: [],
      });
    });

    it("rejects unknown surfaces", () => {
      expect(
        instanceVisibilitySettingsSchema.safeParse({
          companySurfaces: ["company.members", "instance.general"],
        }).success,
      ).toBe(false);
      expect(
        instanceVisibilitySettingsSchema.safeParse({ companySurfaces: ["bogus"] }).success,
      ).toBe(false);
    });

    it("rejects unknown keys (strict)", () => {
      expect(
        instanceVisibilitySettingsSchema.safeParse({ companySurfaces: [], extra: true }).success,
      ).toBe(false);
    });

    it("PATCH schema requires companySurfaces and is strict", () => {
      expect(patchInstanceVisibilitySettingsSchema.safeParse({}).success).toBe(false);
      expect(
        patchInstanceVisibilitySettingsSchema.parse({ companySurfaces: ["company.secrets"] }),
      ).toEqual({ companySurfaces: ["company.secrets"] });
    });
  });
  ```

- [ ] Run: `cd packages/shared && pnpm vitest run src/validators/instance-visibility.test.ts` — expected failure: `does not provide an export named 'instanceVisibilitySettingsSchema'`.
- [ ] In `packages/shared/src/types/instance.ts`, change line 1 from

  ```ts
  import type { FeedbackDataSharingPreference } from "./feedback.js";
  ```

  to

  ```ts
  import { COMPANY_SETTINGS_SURFACES, type CompanySettingsSurface } from "../constants.js";
  import type { FeedbackDataSharingPreference } from "./feedback.js";
  ```

  and insert immediately before the `export interface InstanceSettings {` block (line 91):

  ```ts
  /**
   * Instance-wide settings-surface visibility policy (PR-1). Decides which
   * company-scoped settings surfaces non-admin company members may use.
   * Instance-scoped surfaces are never part of the policy. Default: all
   * company surfaces exposed (zero behavior change for self-hosters).
   */
  export interface InstanceVisibilitySettings {
    companySurfaces: CompanySettingsSurface[];
  }

  export const DEFAULT_INSTANCE_VISIBILITY_SETTINGS: InstanceVisibilitySettings = {
    companySurfaces: [...COMPANY_SETTINGS_SURFACES],
  };
  ```

  then add to `InstanceSettings` (after `experimental: InstanceExperimentalSettings;`):

  ```ts
    visibility: InstanceVisibilitySettings;
  ```

- [ ] In `packages/shared/src/validators/instance.ts`, add to the import list from `../types/instance.js` nothing new, but add a new top-level import after line 11:

  ```ts
  import { COMPANY_SETTINGS_SURFACES } from "../constants.js";
  ```

  Insert after `patchInstanceSettingsSchema` (line 86):

  ```ts
  export const instanceVisibilitySettingsSchema = z.object({
    companySurfaces: z
      .array(z.enum(COMPANY_SETTINGS_SURFACES))
      .default([...COMPANY_SETTINGS_SURFACES]),
  }).strict();

  export const patchInstanceVisibilitySettingsSchema = z.object({
    companySurfaces: z.array(z.enum(COMPANY_SETTINGS_SURFACES)),
  }).strict();
  ```

  Add to the type exports (after line 101 `export type PatchInstanceSettings = …`):

  ```ts
  export type InstanceVisibilitySettings = z.infer<typeof instanceVisibilitySettingsSchema>;
  export type PatchInstanceVisibilitySettings = z.infer<typeof patchInstanceVisibilitySettingsSchema>;
  ```

  (The z.infer alias is structurally identical to the interface in types/instance.ts — same duplication pattern as `InstanceGeneralSettings`, which exists in both files today.)

  Add to `instanceSettingsSchema` (after `experimental: instanceExperimentalSettingsSchema,` at line 110):

  ```ts
    visibility: instanceVisibilitySettingsSchema,
  ```

- [ ] Wire barrels:
  - `packages/shared/src/types/index.ts`: add `InstanceVisibilitySettings,` to the `export type { … } from "./instance.js";` block (lines 42–50), and `DEFAULT_INSTANCE_VISIBILITY_SETTINGS,` to the `export { … } from "./instance.js";` value block (lines 66–75).
  - `packages/shared/src/validators/index.ts`: add `instanceVisibilitySettingsSchema,`, `patchInstanceVisibilitySettingsSchema,`, `type PatchInstanceVisibilitySettings,` to the block from `./instance.js` (lines 1–15).
  - `packages/shared/src/index.ts`: add `InstanceVisibilitySettings,` next to `InstanceSettings,` (~line 632, block sourced from `./types/index.js`); add `DEFAULT_INSTANCE_VISIBILITY_SETTINGS,` to the value block ending `} from "./types/instance.js";` (~line 1305); add `instanceVisibilitySettingsSchema,`, `patchInstanceVisibilitySettingsSchema,`, `type PatchInstanceVisibilitySettings,` to the validators block ending `} from "./validators/index.js";` (~line 1376).
- [ ] Run: `cd packages/shared && pnpm vitest run src/validators/instance-visibility.test.ts src/settings-surfaces.test.ts` — expected: all pass.
- [ ] Run: `cd packages/shared && pnpm typecheck && pnpm build` — expected: clean. NOTE: `pnpm typecheck` across server/ui will be temporarily red on `InstanceSettings.visibility` only where server code constructs `InstanceSettings` objects — Task 4 fixes the single constructor (`toInstanceSettings`). Check now: `cd server && pnpm tsc --noEmit 2>&1 | grep -c visibility` — if nonzero, all hits must be in `server/src/services/instance-settings.ts` and test fixtures; anything else is unexpected.
- [ ] Commit:

  ```
  git add packages/shared/src
  git commit -m "feat(shared): add InstanceVisibilitySettings type and validators

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 3: DB column + hand-written migration

A DB migration IS needed: `instance_settings` stores each settings section in its own jsonb column (`general`, `experimental` — see `packages/db/src/schema/instance_settings.ts:10-11`), so the new `visibility` section requires a new jsonb column. Per repo constraints the SQL and journal entry are hand-written (no drizzle-kit, no snapshot — matching 0168–0172).

**Files:**
- Modify: `packages/db/src/schema/instance_settings.ts` (line 11, after `experimental`)
- Create: `packages/db/src/migrations/0173_instance_settings_visibility.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json` (append entry after idx 172)
- Test: covered by the embedded-postgres persistence test written in Task 4 (`startEmbeddedPostgresTestDatabase` runs `applyPendingMigrations` — `packages/db/src/test-embedded-postgres.ts:163` — so the new migration is exercised there). This task's own verification is the ordering/lint check below.

**Interfaces:**
- Produces: `instanceSettings.visibility` drizzle column (`jsonb`, `$type<Record<string, unknown>>()`, notNull, default `{}`), available as `row.visibility` on `$inferSelect`.

**Steps:**

- [ ] In `packages/db/src/schema/instance_settings.ts`, insert after line 11 (`experimental: …`):

  ```ts
      visibility: jsonb("visibility").$type<Record<string, unknown>>().notNull().default({}),
  ```

- [ ] Create `packages/db/src/migrations/0173_instance_settings_visibility.sql`:

  ```sql
  -- Settings-surface policy (PR-1): per-section jsonb column for the instance
  -- visibility policy, beside "general" and "experimental". Empty object means
  -- "use defaults" (all company surfaces exposed), so existing rows keep
  -- self-hosted behavior unchanged.
  ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "visibility" jsonb DEFAULT '{}'::jsonb NOT NULL;
  ```

- [ ] Append to the `entries` array in `packages/db/src/migrations/meta/_journal.json` (after the idx 172 entry, keeping valid JSON):

  ```json
  {
    "idx": 173,
    "version": "7",
    "when": 1784332800000,
    "tag": "0173_instance_settings_visibility",
    "breakpoints": true
  }
  ```

- [ ] Verify: `python3 -c "import json;j=json.load(open('packages/db/src/migrations/meta/_journal.json'));e=j['entries'];assert e[-1]['tag']=='0173_instance_settings_visibility' and e[-1]['idx']==e[-2]['idx']+1 and e[-1]['when']>e[-2]['when'];print('journal ok')"` — expected: `journal ok`.
- [ ] Run: `cd packages/db && pnpm typecheck` (or `pnpm tsc --noEmit` if no typecheck script) — expected: clean.
- [ ] Commit:

  ```
  git add packages/db/src/schema/instance_settings.ts packages/db/src/migrations
  git commit -m "feat(db): add instance_settings.visibility jsonb column

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 4: Instance-settings service — normalize/get/update visibility

**Files:**
- Modify: `server/src/services/instance-settings.ts` (imports at lines 1–16; storage schemas at lines 19–20; `toInstanceSettings` at lines 273–282; `getOrCreateRow` insert values at lines 296–302; service object at lines 323–390)
- Test (pure): `server/src/__tests__/instance-settings-service.test.ts` (append tests)
- Test (persistence, exercises the Task 3 migration): `server/src/__tests__/instance-settings-visibility-service.test.ts` (create)

**Interfaces:**
- Consumes: `instanceVisibilitySettingsSchema`, `type InstanceVisibilitySettings`, `type PatchInstanceVisibilitySettings`, `COMPANY_SETTINGS_SURFACES` from `@paperclipai/shared`.
- Produces:
  - `export function normalizeVisibilitySettings(raw: unknown): InstanceVisibilitySettings`
  - service methods `getVisibility(): Promise<InstanceVisibilitySettings>` and `updateVisibility(patch: PatchInstanceVisibilitySettings): Promise<InstanceSettings>` on the object returned by `instanceSettingsService(db)`
  - `toInstanceSettings` now populates `visibility` (fixes the Task 2 typecheck gap).

**Steps:**

- [ ] Append to `server/src/__tests__/instance-settings-service.test.ts` (inside the existing `describe("instance settings service", …)`), importing `normalizeVisibilitySettings` in the existing import block from `../services/instance-settings.js` and `COMPANY_SETTINGS_SURFACES` from `@paperclipai/shared`:

  ```ts
  it("defaults visibility to all company surfaces for empty/legacy rows", () => {
    expect(normalizeVisibilitySettings(undefined)).toEqual({
      companySurfaces: [...COMPANY_SETTINGS_SURFACES],
    });
    expect(normalizeVisibilitySettings({})).toEqual({
      companySurfaces: [...COMPANY_SETTINGS_SURFACES],
    });
  });

  it("canonicalizes stored visibility order and drops duplicates", () => {
    expect(
      normalizeVisibilitySettings({
        companySurfaces: ["company.secrets", "company.general", "company.secrets"],
      }),
    ).toEqual({ companySurfaces: ["company.general", "company.secrets"] });
  });

  it("keeps an explicit empty visibility list", () => {
    expect(normalizeVisibilitySettings({ companySurfaces: [] })).toEqual({
      companySurfaces: [],
    });
  });

  it("falls back to the exposed-everything default for corrupt visibility rows", () => {
    expect(normalizeVisibilitySettings({ companySurfaces: ["nonsense"] })).toEqual({
      companySurfaces: [...COMPANY_SETTINGS_SURFACES],
    });
    expect(normalizeVisibilitySettings("garbage")).toEqual({
      companySurfaces: [...COMPANY_SETTINGS_SURFACES],
    });
  });
  ```

- [ ] Run: `cd server && pnpm vitest run src/__tests__/instance-settings-service.test.ts` — expected failure: `does not provide an export named 'normalizeVisibilitySettings'`.
- [ ] Implement in `server/src/services/instance-settings.ts`:
  - Extend the `@paperclipai/shared` import (lines 3–15) with:

    ```ts
    COMPANY_SETTINGS_SURFACES,
    instanceVisibilitySettingsSchema,
    type InstanceVisibilitySettings,
    type PatchInstanceVisibilitySettings,
    ```

  - After line 20 (`const instanceExperimentalSettingsStorageSchema = …`):

    ```ts
    const instanceVisibilitySettingsStorageSchema = instanceVisibilitySettingsSchema.strip();
    ```

  - After `normalizeExperimentalSettings` (i.e. after line 271):

    ```ts
    export function normalizeVisibilitySettings(raw: unknown): InstanceVisibilitySettings {
      const parsed = instanceVisibilitySettingsStorageSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        // Corrupt row: fall back to the spec default (everything exposed),
        // mirroring normalizeGeneralSettings/normalizeExperimentalSettings.
        return { companySurfaces: [...COMPANY_SETTINGS_SURFACES] };
      }
      const stored = parsed.data.companySurfaces;
      // Canonical order + dedupe: intersect the constant list with the stored set.
      return {
        companySurfaces: COMPANY_SETTINGS_SURFACES.filter((surface) => stored.includes(surface)),
      };
    }
    ```

  - In `toInstanceSettings` (lines 273–282) add after the `experimental:` line:

    ```ts
        visibility: normalizeVisibilitySettings(row.visibility),
    ```

  - In `getOrCreateRow`'s insert `.values({ … })` (lines 296–302) add `visibility: {},` after `experimental: {},`.
  - In the returned service object, after `getExperimental` (line 350):

    ```ts
    getVisibility: async (): Promise<InstanceVisibilitySettings> => {
      const row = await getOrCreateRow();
      return normalizeVisibilitySettings(row.visibility);
    },
    ```

    and after `updateExperimental` (line 383):

    ```ts
    updateVisibility: async (patch: PatchInstanceVisibilitySettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextVisibility = normalizeVisibilitySettings({
        ...normalizeVisibilitySettings(current.visibility),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          visibility: { ...nextVisibility },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },
    ```

- [ ] Run: `cd server && pnpm vitest run src/__tests__/instance-settings-service.test.ts` — expected: all pass (existing + 4 new).
- [ ] Write the persistence test `server/src/__tests__/instance-settings-visibility-service.test.ts` (embedded-postgres harness modeled on `access-routes-permissions-upgrade.test.ts:1-27,82-100`):

  ```ts
  import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
  import { COMPANY_SETTINGS_SURFACES } from "@paperclipai/shared";
  import { createDb } from "@paperclipai/db";
  import {
    getEmbeddedPostgresTestSupport,
    startEmbeddedPostgresTestDatabase,
  } from "./helpers/embedded-postgres.js";
  import { closeDbClient } from "./helpers/embedded-postgres.js";
  import { instanceSettingsService } from "../services/instance-settings.js";

  vi.hoisted(() => {
    process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
    process.env.PAPERCLIP_INSTANCE_ID = "vitest";
    process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
    process.env.PAPERCLIP_IN_WORKTREE = "false";
  });

  const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
  const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

  describeEmbeddedPostgres("instance settings visibility persistence", () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-instance-settings-visibility-");
      db = createDb(tempDb.connectionString);
    }, 60_000);

    afterAll(async () => {
      await closeDbClient(db);
      await tempDb?.cleanup();
    });

    it("defaults to all company surfaces, persists updates, and round-trips through get()", async () => {
      const svc = instanceSettingsService(db);

      await expect(svc.getVisibility()).resolves.toEqual({
        companySurfaces: [...COMPANY_SETTINGS_SURFACES],
      });

      const updated = await svc.updateVisibility({
        companySurfaces: ["company.members", "company.general"],
      });
      expect(updated.visibility).toEqual({
        companySurfaces: ["company.general", "company.members"],
      });

      await expect(svc.getVisibility()).resolves.toEqual({
        companySurfaces: ["company.general", "company.members"],
      });
      const full = await svc.get();
      expect(full.visibility).toEqual({
        companySurfaces: ["company.general", "company.members"],
      });

      const cleared = await svc.updateVisibility({ companySurfaces: [] });
      expect(cleared.visibility).toEqual({ companySurfaces: [] });
    });
  });
  ```

- [ ] Run: `cd server && pnpm vitest run src/__tests__/instance-settings-visibility-service.test.ts` — expected: 1 passed (this also proves migration 0173 applies; a failure like `column "visibility" does not exist` means the journal entry from Task 3 is wrong).
- [ ] Run: `cd server && pnpm tsc --noEmit` — expected: clean (the Task 2 `visibility` gap is now closed by `toInstanceSettings`).
- [ ] Commit:

  ```
  git add server/src/services/instance-settings.ts server/src/__tests__/instance-settings-service.test.ts server/src/__tests__/instance-settings-visibility-service.test.ts
  git commit -m "feat(server): visibility section in instance-settings service

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 5: Shared capabilities types + `derivePublicFeatureFlags`

`PublicFeatureFlags` is the explicit allowlist of flags the UI actually branches on. The experimental flags were enumerated by grepping every non-admin UI read of `/instance/settings/experimental` (30 call sites, list in Task 11): `enableEnvironments, enableIsolatedWorkspaces, enableApps, enablePipelines, enableCases, enableConferenceRoomChat, enableTaskWatchdogs, enableIssuePlanDecompositions, enableExperimentalFileViewer, enableCloudSync, enableExternalObjects, enableSmokeLab, enableBuiltInAgents, enableDecisions, enableGoalsSidebarLink, enableServerInfoDebugView, cloudBilling, cloudTrialBanner`. (`managedExperience` from the spec's example list does not exist anywhere in the codebase and is omitted; `enableStreamlinedLeftNavigation`, `autoRestartDevServerWhenIdle`, `enableIssueGraphLivenessAutoRecovery`, `enableWorkspace*`, `enableWorktreeRunExecution` and the two server-managed worktree fields are read by no non-admin UI and stay server-private.)

Because `GET /instance/settings` and `GET /instance/settings/general` also become admin-only in this PR (spec §3.3), the general/instance fields the non-admin UI reads MUST ride the same payload or those flows break: `keyboardShortcuts` (ui/src/components/Layout.tsx:188-191), `censorUsernameInLogs` (ui/src/components/transcript/useLiveRunTranscripts.ts:150-153,459; ui/src/pages/AgentDetail.tsx:3864-3867), `feedbackDataSharingPreference` (ui/src/pages/IssueDetail.tsx:1772), `executionMode` (ui/src/components/AgentConfigForm.tsx:245-271), `defaultEnvironmentId` (ui/src/components/AgentConfigForm.tsx:443; ui/src/pages/CompanyEnvironments.tsx:1555; ui/src/pages/Agents.tsx:201-206). These are included in `PublicFeatureFlags` — a documented extension of the pinned contract (see "Deviations" at the bottom).

**Files:**
- Create: `packages/shared/src/types/capabilities.ts`
- Modify: `packages/shared/src/types/index.ts` (append export block)
- Modify: `packages/shared/src/index.ts` (append export block after the `./types/instance.js` value block at ~line 1305)
- Test: `packages/shared/src/types/capabilities.test.ts` (create)

**Interfaces:**
- Consumes: `CompanySettingsSurface` from `../constants.js`; `InstanceGeneralSettings`, `InstanceExperimentalSettings` from `./instance.js`; `FeedbackDataSharingPreference` from `./feedback.js`.
- Produces:

  ```ts
  export interface PublicFeatureFlags { /* full field list below */ }
  export type EffectiveStanding = {
    status: "active" | "grace" | "blocked";
    reason?: string;
    message?: string;
    actionUrl?: string;
  };
  export interface BoardCapabilities {
    exposedSurfaces: CompanySettingsSurface[];
    features: PublicFeatureFlags;
    companyStandings: Record<string, EffectiveStanding>;
  }
  export function derivePublicFeatureFlags(input: {
    general: InstanceGeneralSettings;
    experimental: InstanceExperimentalSettings;
    defaultEnvironmentId: string | null;
  }): PublicFeatureFlags;
  ```

**Steps:**

- [ ] Write the failing test `packages/shared/src/types/capabilities.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";
  import {
    instanceExperimentalSettingsSchema,
    instanceGeneralSettingsSchema,
  } from "../validators/instance.js";
  import { derivePublicFeatureFlags, type EffectiveStanding } from "./capabilities.js";

  const defaultGeneral = instanceGeneralSettingsSchema.parse({});
  const defaultExperimental = instanceExperimentalSettingsSchema.parse({});

  describe("derivePublicFeatureFlags", () => {
    it("derives the full allowlist with safe defaults", () => {
      expect(
        derivePublicFeatureFlags({
          general: defaultGeneral,
          experimental: defaultExperimental,
          defaultEnvironmentId: null,
        }),
      ).toEqual({
        enableEnvironments: false,
        enableIsolatedWorkspaces: false,
        enableApps: false,
        enablePipelines: false,
        enableCases: false,
        enableConferenceRoomChat: false,
        enableTaskWatchdogs: false,
        enableIssuePlanDecompositions: false,
        enableExperimentalFileViewer: false,
        enableCloudSync: false,
        enableExternalObjects: false,
        enableSmokeLab: false,
        enableBuiltInAgents: false,
        enableDecisions: false,
        enableGoalsSidebarLink: false,
        enableServerInfoDebugView: false,
        cloudBilling: defaultExperimental.cloudBilling,
        cloudTrialBanner: defaultExperimental.cloudTrialBanner,
        keyboardShortcuts: false,
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: defaultGeneral.feedbackDataSharingPreference,
        executionMode: "any",
        defaultEnvironmentId: null,
      });
    });

    it("passes through enabled flags and instance defaults", () => {
      const flags = derivePublicFeatureFlags({
        general: { ...defaultGeneral, keyboardShortcuts: true, executionMode: "kubernetes" },
        experimental: { ...defaultExperimental, enableEnvironments: true, enableCases: true },
        defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
      });
      expect(flags.enableEnvironments).toBe(true);
      expect(flags.enableCases).toBe(true);
      expect(flags.keyboardShortcuts).toBe(true);
      expect(flags.executionMode).toBe("kubernetes");
      expect(flags.defaultEnvironmentId).toBe("11111111-1111-4111-8111-111111111111");
    });

    it("never leaks non-allowlisted experimental fields", () => {
      const flags = derivePublicFeatureFlags({
        general: defaultGeneral,
        experimental: { ...defaultExperimental, enableWorktreeRunExecution: true },
        defaultEnvironmentId: null,
      });
      expect("enableWorktreeRunExecution" in flags).toBe(false);
      expect("worktreeRunExecutionActivatedAt" in flags).toBe(false);
      expect("enableIssueGraphLivenessAutoRecovery" in flags).toBe(false);
    });

    it("EffectiveStanding type-checks the PR-3 contract shape", () => {
      const standing: EffectiveStanding = {
        status: "blocked",
        reason: "subscription_lapsed",
        message: "Subscription lapsed",
        actionUrl: "/billing",
      };
      expect(standing.status).toBe("blocked");
    });
  });
  ```

- [ ] Run: `cd packages/shared && pnpm vitest run src/types/capabilities.test.ts` — expected failure: `Cannot find module './capabilities.js'` (or missing-export error).
- [ ] Create `packages/shared/src/types/capabilities.ts`:

  ```ts
  import type { CompanySettingsSurface } from "../constants.js";
  import type { FeedbackDataSharingPreference } from "./feedback.js";
  import type {
    InstanceExecutionMode,
    InstanceExperimentalSettings,
    InstanceGeneralSettings,
  } from "./instance.js";

  /**
   * Explicit, reviewed allowlist of instance settings the frontend branches on.
   * Delivered via `GET /cli-auth/me` capabilities so the UI never reads
   * `/instance/settings*` directly (those reads are instance-admin-only).
   * Anything not listed here stays server-private.
   */
  export interface PublicFeatureFlags {
    // Derived from instance experimental settings.
    enableEnvironments: boolean;
    enableIsolatedWorkspaces: boolean;
    enableApps: boolean;
    enablePipelines: boolean;
    enableCases: boolean;
    enableConferenceRoomChat: boolean;
    enableTaskWatchdogs: boolean;
    enableIssuePlanDecompositions: boolean;
    enableExperimentalFileViewer: boolean;
    enableCloudSync: boolean;
    enableExternalObjects: boolean;
    enableSmokeLab: boolean;
    enableBuiltInAgents: boolean;
    enableDecisions: boolean;
    enableGoalsSidebarLink: boolean;
    enableServerInfoDebugView: boolean;
    cloudBilling: boolean;
    cloudTrialBanner: boolean;
    // Derived from instance general settings / instance defaults. These ride
    // the capabilities payload because the /instance/settings reads that used
    // to serve them are instance-admin-only as of PR-1.
    keyboardShortcuts: boolean;
    censorUsernameInLogs: boolean;
    feedbackDataSharingPreference: FeedbackDataSharingPreference;
    executionMode: InstanceExecutionMode;
    defaultEnvironmentId: string | null;
  }

  /**
   * Effective company standing (PR-3 contract, defined in PR-1).
   * PR-1 always returns an empty `companyStandings` map.
   */
  export type EffectiveStanding = {
    status: "active" | "grace" | "blocked";
    reason?: string;
    message?: string;
    actionUrl?: string;
  };

  export interface BoardCapabilities {
    /** Company surfaces the caller may use. Full list for instance admins. */
    exposedSurfaces: CompanySettingsSurface[];
    features: PublicFeatureFlags;
    /** Keyed by company id. Empty until PR-3 populates it. */
    companyStandings: Record<string, EffectiveStanding>;
  }

  export function derivePublicFeatureFlags(input: {
    general: InstanceGeneralSettings;
    experimental: InstanceExperimentalSettings;
    defaultEnvironmentId: string | null;
  }): PublicFeatureFlags {
    const { general, experimental, defaultEnvironmentId } = input;
    return {
      enableEnvironments: experimental.enableEnvironments === true,
      enableIsolatedWorkspaces: experimental.enableIsolatedWorkspaces === true,
      enableApps: experimental.enableApps === true,
      enablePipelines: experimental.enablePipelines === true,
      enableCases: experimental.enableCases === true,
      enableConferenceRoomChat: experimental.enableConferenceRoomChat === true,
      enableTaskWatchdogs: experimental.enableTaskWatchdogs === true,
      enableIssuePlanDecompositions: experimental.enableIssuePlanDecompositions === true,
      enableExperimentalFileViewer: experimental.enableExperimentalFileViewer === true,
      enableCloudSync: experimental.enableCloudSync === true,
      enableExternalObjects: experimental.enableExternalObjects === true,
      enableSmokeLab: experimental.enableSmokeLab === true,
      enableBuiltInAgents: experimental.enableBuiltInAgents === true,
      enableDecisions: experimental.enableDecisions === true,
      enableGoalsSidebarLink: experimental.enableGoalsSidebarLink === true,
      enableServerInfoDebugView: experimental.enableServerInfoDebugView === true,
      cloudBilling: experimental.cloudBilling === true,
      cloudTrialBanner: experimental.cloudTrialBanner === true,
      keyboardShortcuts: general.keyboardShortcuts === true,
      censorUsernameInLogs: general.censorUsernameInLogs === true,
      feedbackDataSharingPreference: general.feedbackDataSharingPreference,
      executionMode: general.executionMode ?? "any",
      defaultEnvironmentId,
    };
  }
  ```

- [ ] Wire barrels — append to `packages/shared/src/types/index.ts`:

  ```ts
  export type {
    PublicFeatureFlags,
    EffectiveStanding,
    BoardCapabilities,
  } from "./capabilities.js";
  export { derivePublicFeatureFlags } from "./capabilities.js";
  ```

  and append to `packages/shared/src/index.ts` (directly after the block ending `} from "./types/instance.js";` at ~line 1305):

  ```ts
  export type {
    PublicFeatureFlags,
    EffectiveStanding,
    BoardCapabilities,
  } from "./types/capabilities.js";
  export { derivePublicFeatureFlags } from "./types/capabilities.js";
  ```

- [ ] Run: `cd packages/shared && pnpm vitest run src/types/capabilities.test.ts` — expected: 4 passed. Then `pnpm typecheck && pnpm build`.
- [ ] Commit:

  ```
  git add packages/shared/src
  git commit -m "feat(shared): PublicFeatureFlags, EffectiveStanding, BoardCapabilities and derivePublicFeatureFlags

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 6: `GET/PATCH /instance/settings/visibility` routes

**Files:**
- Modify: `server/src/routes/instance-settings.ts` (shared import at lines 3–8; new routes after the `/instance/settings/experimental` PATCH block, i.e. after line 147)
- Test: `server/src/__tests__/instance-settings-routes.test.ts` (extend mocks + add describe block)

**Interfaces:**
- Consumes: `patchInstanceVisibilitySettingsSchema` from `@paperclipai/shared`; existing local `assertCanManageInstanceSettings` (server/src/routes/instance-settings.ts:16-24); `svc.getVisibility` / `svc.updateVisibility` (Task 4); `logActivity`, `getActorInfo`.
- Produces: `GET /instance/settings/visibility` → `InstanceVisibilitySettings` (admin-only; non-admins get surfaces via `/cli-auth/me` capabilities); `PATCH /instance/settings/visibility` (body `{ companySurfaces: CompanySettingsSurface[] }`) → updated `InstanceVisibilitySettings`, activity-logged as `instance.settings.visibility_updated`.

**Steps:**

- [ ] Extend the test harness in `server/src/__tests__/instance-settings-routes.test.ts`:
  - Add to `mockInstanceSettingsService` (lines 5–13): `getVisibility: vi.fn(),` and `updateVisibility: vi.fn(),`.
  - Add to the `beforeEach` reset list (lines 59–65): `mockInstanceSettingsService.getVisibility.mockReset();` and `mockInstanceSettingsService.updateVisibility.mockReset();`.
  - Add default resolved values at the end of `beforeEach` (after line 186):

    ```ts
    mockInstanceSettingsService.getVisibility.mockResolvedValue({
      companySurfaces: [
        "company.general",
        "company.members",
        "company.invites",
        "company.secrets",
        "company.plugins",
      ],
    });
    mockInstanceSettingsService.updateVisibility.mockResolvedValue({
      id: "instance-settings-1",
      visibility: { companySurfaces: ["company.general", "company.members"] },
    });
    ```

- [ ] Add the failing tests (new `it` blocks inside the existing describe):

  ```ts
  it("allows instance admins to read and update the visibility policy", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings/visibility");
    expect(getRes.status).toBe(200);
    expect(getRes.body.companySurfaces).toContain("company.members");

    const patchRes = await request(app)
      .patch("/api/instance/settings/visibility")
      .send({ companySurfaces: ["company.general", "company.members"] });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toEqual({
      companySurfaces: ["company.general", "company.members"],
    });
    expect(mockInstanceSettingsService.updateVisibility).toHaveBeenCalledWith({
      companySurfaces: ["company.general", "company.members"],
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("rejects non-admin board users from reading or updating the visibility policy", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    await request(app).get("/api/instance/settings/visibility").expect(403);
    await request(app)
      .patch("/api/instance/settings/visibility")
      .send({ companySurfaces: [] })
      .expect(403);
    expect(mockInstanceSettingsService.updateVisibility).not.toHaveBeenCalled();
  });

  it("rejects agent callers from the visibility policy", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    await request(app)
      .patch("/api/instance/settings/visibility")
      .send({ companySurfaces: [] })
      .expect(403);
  });

  it("rejects unknown surfaces in the visibility patch with a validation error", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .patch("/api/instance/settings/visibility")
      .send({ companySurfaces: ["instance.general"] });
    expect(res.status).toBe(400);
    expect(mockInstanceSettingsService.updateVisibility).not.toHaveBeenCalled();
  });
  ```

- [ ] Run: `cd server && pnpm vitest run src/__tests__/instance-settings-routes.test.ts` — expected: the 4 new tests fail with 404s (route not registered); existing tests still pass.
- [ ] Implement in `server/src/routes/instance-settings.ts`:
  - Add `patchInstanceVisibilitySettingsSchema,` to the `@paperclipai/shared` import (lines 3–8).
  - Insert after the `/instance/settings/experimental` PATCH handler (after line 147):

    ```ts
    router.get("/instance/settings/visibility", async (req, res) => {
      // Admin-only read: non-admins receive the exposed surfaces via the
      // /cli-auth/me capabilities payload, never the raw policy.
      assertCanManageInstanceSettings(req);
      res.json(await svc.getVisibility());
    });

    router.patch(
      "/instance/settings/visibility",
      validate(patchInstanceVisibilitySettingsSchema),
      async (req, res) => {
        assertCanManageInstanceSettings(req);
        const updated = await svc.updateVisibility(req.body);
        const actor = getActorInfo(req);
        const companyIds = await svc.listCompanyIds();
        await Promise.all(
          companyIds.map((companyId) =>
            logActivity(db, {
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "instance.settings.visibility_updated",
              entityType: "instance_settings",
              entityId: updated.id,
              details: {
                visibility: updated.visibility,
                changedKeys: Object.keys(req.body).sort(),
              },
            }),
          ),
        );
        res.json(updated.visibility);
      },
    );
    ```

- [ ] Run: `cd server && pnpm vitest run src/__tests__/instance-settings-routes.test.ts` — expected: all pass.
- [ ] Commit:

  ```
  git add server/src/routes/instance-settings.ts server/src/__tests__/instance-settings-routes.test.ts
  git commit -m "feat(server): GET/PATCH /instance/settings/visibility (instance-admin only)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 7: Close the read hole — `/instance/settings`, `/general`, `/experimental` become admin-only

This is the one deliberate behavior change (spec §3.3). The UI migration that makes it safe ships in Tasks 11–12 of this same PR.

**Files:**
- Modify: `server/src/routes/instance-settings.ts` (GET handlers at lines 32-35, 74-79, 111-117; import at line 14)
- Test: `server/src/__tests__/instance-settings-routes.test.ts` (flip two existing tests, add regression tests)

**Interfaces:**
- Consumes: existing `assertCanManageInstanceSettings` (unchanged; already returns for `source === "local_implicit"` OR `isInstanceAdmin` — server/src/routes/instance-settings.ts:16-24, which is exactly the required `local_trusted` + instance-admin bypass).
- Produces: 403 for non-admin board reads of all three GET endpoints; unchanged 200s for `local_implicit` and instance admins.

**Steps:**

- [ ] Update the two existing tests that assert non-admin reads succeed, and add explicit regressions. In `server/src/__tests__/instance-settings-routes.test.ts`:
  - Replace the test at line 511 (`"allows non-admin board users with company access to read but not update experimental settings"`) with:

    ```ts
    it("rejects non-admin board users from reading or updating experimental settings", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-1"],
      });

      await request(app).get("/api/instance/settings/experimental").expect(403);
      expect(mockInstanceSettingsService.getExperimental).not.toHaveBeenCalled();

      await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableTaskWatchdogs: true })
        .expect(403);
      expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
    });
    ```

  - Replace the test at line 563 (`"allows non-admin board users to read general settings"`) with:

    ```ts
    it("rejects non-admin board users from reading general settings", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-1"],
      });

      const res = await request(app).get("/api/instance/settings/general");
      expect(res.status).toBe(403);
      expect(mockInstanceSettingsService.getGeneral).not.toHaveBeenCalled();
    });
    ```

  - Add two new tests:

    ```ts
    it("rejects non-admin board users from reading the full instance settings", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-1"],
      });

      await request(app).get("/api/instance/settings").expect(403);
      expect(mockInstanceSettingsService.get).not.toHaveBeenCalled();
    });

    it("local_trusted regression: the implicit local actor still reads everything", async () => {
      const app = await createApp({
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      });

      await request(app).get("/api/instance/settings").expect(200);
      await request(app).get("/api/instance/settings/general").expect(200);
      await request(app).get("/api/instance/settings/experimental").expect(200);
      await request(app).get("/api/instance/settings/visibility").expect(200);
    });
    ```

- [ ] Run: `cd server && pnpm vitest run src/__tests__/instance-settings-routes.test.ts` — expected: the two replaced tests + the new full-settings test FAIL (reads currently return 200 for non-admins); local_trusted regression passes.
- [ ] Implement in `server/src/routes/instance-settings.ts`:
  - Line 33: `assertBoardOrgAccess(req);` → `assertCanManageInstanceSettings(req);`
  - Lines 74–78: replace the comment + assert with:

    ```ts
    router.get("/instance/settings/general", async (req, res) => {
      // Instance-admin-only read (PR-1). Non-admin UI consumes the public
      // subset via GET /cli-auth/me capabilities.features instead.
      assertCanManageInstanceSettings(req);
      res.json(await svc.getGeneral());
    });
    ```

  - Lines 111–116: replace the comment + assert the same way for `/instance/settings/experimental`:

    ```ts
    router.get("/instance/settings/experimental", async (req, res) => {
      // Instance-admin-only read (PR-1). Non-admin UI consumes the allowlisted
      // flag subset via GET /cli-auth/me capabilities.features instead.
      assertCanManageInstanceSettings(req);
      res.json(await svc.getExperimental());
    });
    ```

  - Line 14: `import { assertBoardOrgAccess, getActorInfo } from "./authz.js";` → `import { getActorInfo } from "./authz.js";` (no remaining `assertBoardOrgAccess` callers in this file).
- [ ] Run: `cd server && pnpm vitest run src/__tests__/instance-settings-routes.test.ts` — expected: all pass. Also `cd server && pnpm tsc --noEmit`.
- [ ] Commit:

  ```
  git add server/src/routes/instance-settings.ts server/src/__tests__/instance-settings-routes.test.ts
  git commit -m "feat(server)!: instance settings reads require instance admin

  GET /instance/settings, /general, /experimental move from
  assertBoardOrgAccess to assertCanManageInstanceSettings. The UI migrates
  to /cli-auth/me capabilities.features in the same PR.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 8: `assertSurfaceExposed` in `server/src/routes/authz.ts`

`authz.ts` helpers are DB-free (`assertBoardOrgAccess` etc. read only `req.actor`), so the exposed-surface list is passed as an async resolver — the helper short-circuits for bypass actors WITHOUT touching the DB. The pinned exported name is kept; the parameter shape follows the file's `(req, …)` style.

**Files:**
- Modify: `server/src/routes/authz.ts` (imports at lines 1–4; new export after `assertInstanceAdmin`, i.e. after line 72)
- Test: `server/src/__tests__/authz-surface-exposure.test.ts` (create)

**Interfaces:**
- Produces:

  ```ts
  export async function assertSurfaceExposed(
    req: Request,
    surface: CompanySettingsSurface,
    getExposedSurfaces: () => Promise<readonly CompanySettingsSurface[]>,
  ): Promise<void>
  ```

  Throws `HttpError(403, …, { code: "surface_not_exposed", surface })` — serialized by the error handler (server/src/middleware/error-handler.ts:81-109) as `{ error, code: "surface_not_exposed", details: { code, surface } }`.
- Bypass rules: `req.actor.type === "agent"` → allow (the policy governs human settings surfaces; agent runtime access on shared route groups, e.g. secrets, is governed by its own scopes); board with `source === "local_implicit"` or `isInstanceAdmin` → allow without evaluating the resolver.

**Steps:**

- [ ] Write the failing test `server/src/__tests__/authz-surface-exposure.test.ts`:

  ```ts
  import type { Request } from "express";
  import { describe, expect, it, vi } from "vitest";
  import { assertSurfaceExposed } from "../routes/authz.js";
  import { HttpError } from "../errors.js";

  function reqWithActor(actor: Record<string, unknown>): Request {
    return { actor } as unknown as Request;
  }

  const exposedNone = vi.fn(async () => [] as const);
  const exposedMembers = async () => ["company.members"] as const;

  describe("assertSurfaceExposed", () => {
    it("bypasses local_trusted implicit actors without reading the policy", async () => {
      exposedNone.mockClear();
      await assertSurfaceExposed(
        reqWithActor({ type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true }),
        "company.secrets",
        exposedNone,
      );
      expect(exposedNone).not.toHaveBeenCalled();
    });

    it("bypasses instance admins without reading the policy", async () => {
      exposedNone.mockClear();
      await assertSurfaceExposed(
        reqWithActor({ type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true }),
        "company.secrets",
        exposedNone,
      );
      expect(exposedNone).not.toHaveBeenCalled();
    });

    it("bypasses agent actors (agent access is governed by agent scopes)", async () => {
      await expect(
        assertSurfaceExposed(
          reqWithActor({ type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" }),
          "company.secrets",
          async () => [],
        ),
      ).resolves.toBeUndefined();
    });

    it.each(["owner", "admin", "operator", "viewer"] as const)(
      "allows a %s member on an exposed surface",
      async (membershipRole) => {
        await expect(
          assertSurfaceExposed(
            reqWithActor({
              type: "board",
              userId: "user-1",
              source: "session",
              isInstanceAdmin: false,
              companyIds: ["company-1"],
              memberships: [{ companyId: "company-1", membershipRole, status: "active" }],
            }),
            "company.members",
            exposedMembers,
          ),
        ).resolves.toBeUndefined();
      },
    );

    it.each(["owner", "admin", "operator", "viewer"] as const)(
      "rejects a %s member on a hidden surface with a typed 403",
      async (membershipRole) => {
        const attempt = assertSurfaceExposed(
          reqWithActor({
            type: "board",
            userId: "user-1",
            source: "session",
            isInstanceAdmin: false,
            companyIds: ["company-1"],
            memberships: [{ companyId: "company-1", membershipRole, status: "active" }],
          }),
          "company.secrets",
          exposedMembers,
        );
        await expect(attempt).rejects.toMatchObject({
          status: 403,
          details: { code: "surface_not_exposed", surface: "company.secrets" },
        });
        await expect(attempt).rejects.toBeInstanceOf(HttpError);
      },
    );

    it("rejects unauthenticated actors on a hidden surface", async () => {
      await expect(
        assertSurfaceExposed(reqWithActor({ type: "none", source: "none" }), "company.invites", async () => []),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
  ```

- [ ] Run: `cd server && pnpm vitest run src/__tests__/authz-surface-exposure.test.ts` — expected failure: `does not provide an export named 'assertSurfaceExposed'`.
- [ ] Implement in `server/src/routes/authz.ts`:
  - Add after line 1:

    ```ts
    import type { CompanySettingsSurface } from "@paperclipai/shared";
    ```

  - Insert after `assertInstanceAdmin` (line 72):

    ```ts
    /**
     * Settings-surface policy gate (PR-1). Company-scoped settings surfaces can
     * be hidden instance-wide from non-admin board members. Instance admins and
     * the local_trusted implicit actor always bypass (the resolver is not even
     * called for them). Agent actors bypass: the policy governs human settings
     * surfaces; agent access to shared route groups is governed by agent scopes.
     *
     * `getExposedSurfaces` is injected (typically
     * `instanceSettingsService(db).getVisibility().companySurfaces`) because
     * this module is deliberately DB-free.
     */
    export async function assertSurfaceExposed(
      req: Request,
      surface: CompanySettingsSurface,
      getExposedSurfaces: () => Promise<readonly CompanySettingsSurface[]>,
    ): Promise<void> {
      if (req.actor.type === "agent") return;
      if (
        req.actor.type === "board" &&
        (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)
      ) {
        return;
      }
      const exposed = await getExposedSurfaces();
      if (exposed.includes(surface)) return;
      throw forbidden("This settings surface is not exposed on this instance", {
        code: "surface_not_exposed",
        surface,
      });
    }
    ```

- [ ] Run: `cd server && pnpm vitest run src/__tests__/authz-surface-exposure.test.ts` — expected: 12 passed.
- [ ] Commit:

  ```
  git add server/src/routes/authz.ts server/src/__tests__/authz-surface-exposure.test.ts
  git commit -m "feat(server): assertSurfaceExposed authz helper with typed surface_not_exposed 403

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 9: Capabilities payload on `GET /cli-auth/me`

**Files:**
- Modify: `server/src/routes/access.ts` (services import at lines 67–74; factory locals right after `const agents = agentService(db);` inside `accessRoutes` at ~line 2621; the `/cli-auth/me` handler at lines 2853–2868; shared import block at lines 31–49)
- Test: `server/src/__tests__/cli-auth-me-capabilities.test.ts` (create, embedded-postgres)

**Interfaces:**
- Consumes: `instanceSettingsService` from `../services/index.js` (already exported there; used the same way by `server/src/routes/instance-settings.ts:11,28`); `COMPANY_SETTINGS_SURFACES`, `derivePublicFeatureFlags`, `type BoardCapabilities` from `@paperclipai/shared`; `settings.visibility` from Task 4.
- Produces: response gains `capabilities: BoardCapabilities`. Also fixes `isInstanceAdmin` for the local_trusted implicit actor: today the route computes it ONLY from `boardAuth.resolveBoardAccess(userId)` (DB role rows), which is `false` for the synthetic `local-board` user (server/src/middleware/auth.ts:144-154 sets `isInstanceAdmin: true` on the actor, but access.ts:2861 ignores it). The payload now ORs in the actor claim — required for the `local_trusted sees everything` regression once nav renders from this payload.

**Steps:**

- [ ] Write the failing test `server/src/__tests__/cli-auth-me-capabilities.test.ts`:

  ```ts
  import express from "express";
  import request from "supertest";
  import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
  import { and, eq } from "drizzle-orm";
  import { createDb, instanceUserRoles, authUsers } from "@paperclipai/db";
  import { COMPANY_SETTINGS_SURFACES } from "@paperclipai/shared";
  import {
    closeDbClient,
    getEmbeddedPostgresTestSupport,
    startEmbeddedPostgresTestDatabase,
  } from "./helpers/embedded-postgres.js";
  import { instanceSettingsService } from "../services/instance-settings.js";

  vi.hoisted(() => {
    process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
    process.env.PAPERCLIP_INSTANCE_ID = "vitest";
    process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
    process.env.PAPERCLIP_IN_WORKTREE = "false";
  });

  const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
  const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

  type Db = ReturnType<typeof createDb>;

  async function createApp(db: Db, actor: Record<string, unknown>) {
    const { accessRoutes } = await import("../routes/access.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as never;
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  describeEmbeddedPostgres("GET /cli-auth/me capabilities", () => {
    let db!: Db;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cli-auth-me-capabilities-");
      db = createDb(tempDb.connectionString);
    }, 60_000);

    afterAll(async () => {
      await closeDbClient(db);
      await tempDb?.cleanup();
    });

    const memberActor = {
      type: "board",
      userId: "user-member",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    };

    it("returns all surfaces + derived features + empty standings under the default policy", async () => {
      const app = await createApp(db, memberActor);
      const res = await request(app).get("/api/cli-auth/me");
      expect(res.status).toBe(200);
      expect(res.body.capabilities.exposedSurfaces).toEqual([...COMPANY_SETTINGS_SURFACES]);
      expect(res.body.capabilities.companyStandings).toEqual({});
      expect(res.body.capabilities.features).toMatchObject({
        enableEnvironments: false,
        enableCloudSync: false,
        keyboardShortcuts: false,
        executionMode: "any",
        defaultEnvironmentId: null,
      });
      expect(res.body.capabilities.features).not.toHaveProperty("enableWorktreeRunExecution");
    });

    it("reflects the visibility policy for non-admin members and flag toggles in features", async () => {
      const svc = instanceSettingsService(db);
      await svc.updateVisibility({ companySurfaces: ["company.general", "company.members"] });
      await svc.updateExperimental({ enableCloudSync: true });

      const app = await createApp(db, memberActor);
      const res = await request(app).get("/api/cli-auth/me");
      expect(res.status).toBe(200);
      expect(res.body.capabilities.exposedSurfaces).toEqual(["company.general", "company.members"]);
      expect(res.body.capabilities.features.enableCloudSync).toBe(true);
      expect(res.body.isInstanceAdmin).toBe(false);
    });

    it("gives actor-claimed instance admins the full surface list despite a restrictive policy", async () => {
      const app = await createApp(db, { ...memberActor, userId: "user-admin", isInstanceAdmin: true });
      const res = await request(app).get("/api/cli-auth/me");
      expect(res.status).toBe(200);
      expect(res.body.isInstanceAdmin).toBe(true);
      expect(res.body.capabilities.exposedSurfaces).toEqual([...COMPANY_SETTINGS_SURFACES]);
    });

    it("gives DB-role instance admins the full surface list", async () => {
      await db.insert(authUsers).values({ id: "db-admin", name: "DB Admin", email: "dbadmin@example.com" }).onConflictDoNothing();
      await db.insert(instanceUserRoles).values({ userId: "db-admin", role: "instance_admin" }).onConflictDoNothing();
      const app = await createApp(db, {
        type: "board",
        userId: "db-admin",
        source: "session",
        isInstanceAdmin: false, // stale claim; DB role must win
        companyIds: [],
        memberships: [],
      });
      const res = await request(app).get("/api/cli-auth/me");
      expect(res.status).toBe(200);
      expect(res.body.isInstanceAdmin).toBe(true);
      expect(res.body.capabilities.exposedSurfaces).toEqual([...COMPANY_SETTINGS_SURFACES]);
      await db.delete(instanceUserRoles).where(and(eq(instanceUserRoles.userId, "db-admin"), eq(instanceUserRoles.role, "instance_admin")));
    });

    it("local_trusted regression: the implicit actor is an instance admin with every surface", async () => {
      const app = await createApp(db, {
        type: "board",
        userId: "local-board",
        userName: "Local Board",
        userEmail: null,
        isInstanceAdmin: true,
        source: "local_implicit",
      });
      const res = await request(app).get("/api/cli-auth/me");
      expect(res.status).toBe(200);
      expect(res.body.isInstanceAdmin).toBe(true);
      expect(res.body.capabilities.exposedSurfaces).toEqual([...COMPANY_SETTINGS_SURFACES]);
    });
  });
  ```

  NOTE for the implementer: if the `authUsers` insert columns don't match the auth schema (check `packages/db/src/schema/auth.ts` for required fields like `emailVerified`/`createdAt`), extend the `.values({...})` accordingly — the assertion target is the role row, the user row just satisfies any FK.

- [ ] Run: `cd server && pnpm vitest run src/__tests__/cli-auth-me-capabilities.test.ts` — expected failures: `capabilities` is `undefined` in every test; local_trusted test additionally fails on `isInstanceAdmin` being `false`.
- [ ] Implement in `server/src/routes/access.ts`:
  - Add `instanceSettingsService,` to the import from `../services/index.js` (lines 67–74).
  - Add to the `@paperclipai/shared` value import (lines 31–49): `COMPANY_SETTINGS_SURFACES,` and `derivePublicFeatureFlags,`; add `BoardCapabilities` to the type import at line 50.
  - Inside `accessRoutes`, after `const agents = agentService(db);` add:

    ```ts
    const instanceSettings = instanceSettingsService(db);
    ```

  - Replace the `/cli-auth/me` handler (lines 2853–2868) with:

    ```ts
    router.get("/cli-auth/me", async (req, res) => {
      if (req.actor.type !== "board" || !req.actor.userId) {
        throw unauthorized("Board authentication required");
      }
      const [accessSnapshot, settings] = await Promise.all([
        boardAuth.resolveBoardAccess(req.actor.userId),
        instanceSettings.get(),
      ]);
      // The local_trusted implicit actor has no DB role row; honor the actor
      // claim set by the auth middleware alongside the DB-resolved role.
      const isInstanceAdmin =
        req.actor.source === "local_implicit" ||
        req.actor.isInstanceAdmin === true ||
        accessSnapshot.isInstanceAdmin;
      const capabilities: BoardCapabilities = {
        exposedSurfaces: isInstanceAdmin
          ? [...COMPANY_SETTINGS_SURFACES]
          : settings.visibility.companySurfaces,
        features: derivePublicFeatureFlags({
          general: settings.general,
          experimental: settings.experimental,
          defaultEnvironmentId: settings.defaultEnvironmentId,
        }),
        // Populated by PR-3 (company-standing gate); typed and empty until then.
        companyStandings: {},
      };
      res.json({
        user: accessSnapshot.user,
        userId: req.actor.userId,
        isInstanceAdmin,
        companyIds: accessSnapshot.companyIds,
        memberships: accessSnapshot.memberships,
        source: req.actor.source ?? "none",
        keyId: req.actor.source === "board_key" ? req.actor.keyId ?? null : null,
        cloudStack: req.actor.source === "cloud_tenant" ? req.actor.cloudStack ?? null : null,
        capabilities,
      });
    });
    ```

- [ ] Run: `cd server && pnpm vitest run src/__tests__/cli-auth-me-capabilities.test.ts` — expected: 5 passed. Then `cd server && pnpm tsc --noEmit`.
- [ ] Commit:

  ```
  git add server/src/routes/access.ts server/src/__tests__/cli-auth-me-capabilities.test.ts
  git commit -m "feat(server): capabilities payload (exposedSurfaces, features, companyStandings) on GET /cli-auth/me

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 10: Enforce `assertSurfaceExposed` on members/invites/secrets route groups

Per spec §3.4 the gate applies to the company-scoped route groups backing each surface: members/invites management (`server/src/routes/access.ts`) and secrets (`server/src/routes/secrets.ts`). `company.plugins` gets its server gate in PR-2 when the catalog route exists; `company.general` has no dedicated management route group in core (company PATCH is shared with non-settings flows) — both are nav-gated only in PR-1 (see Deviations).

**Files:**
- Modify: `server/src/routes/access.ts`:
  - factory: reuse `instanceSettings` from Task 9; define the resolver once
  - `company.invites` gate: handlers at lines 3293 (POST create invite), 3363 (POST openclaw invite-prompt), 4116 (POST /invites/:inviteId/revoke), 4157 (GET list invites)
  - `company.members` gate: handlers at lines 4165 (GET join-requests), 4180 (approve), 4329 (reject), 4460 (GET members), 4489 (PATCH member), 4586 (role-and-grants), 4713 (archive), 4754 (permissions)
  - NOT gated: `GET /companies/:companyId/user-directory` (4473) — consumed by mentions/pickers across the whole app, not a settings surface.
- Modify: `server/src/routes/secrets.ts`:
  - factory (line 58–62): add `const instanceSettingsSvc = instanceSettingsService(db);` + resolver; import `assertSurfaceExposed` (line 19 import block) and `instanceSettingsService` (line 20 services import)
  - `company.secrets` gate on company-secret management routes: 63, 70, 78, 85, 120 (providers/provider-configs), 155/162/197/226/255 (`/secret-provider-configs/:id*` — insert after the handler's existing company-access check on the loaded config), 284 (GET secrets), 292/298/336/381/410 (user-secret-definitions), 577/612/647 (create/import), 683/723/767/782/797 (`/secrets/:id*` — insert after `getAccessibleResource` returns non-null)
  - NOT gated: `/companies/:companyId/me/user-secrets*` (lines 417–549) — per-user secret VALUES are prompted from run/agent flows outside the settings page; hiding the company secrets surface must not break them.
- Test: `server/src/__tests__/settings-surface-gating-routes.test.ts` (create, embedded-postgres)

**Interfaces:**
- Consumes: `assertSurfaceExposed` (Task 8), `instanceSettingsService(db).getVisibility()` (Task 4).
- Produces: per-file resolver

  ```ts
  const getExposedCompanySurfaces = async () =>
    (await instanceSettings.getVisibility()).companySurfaces;
  ```

  and one inserted line per handler:

  ```ts
  await assertSurfaceExposed(req, "company.members", getExposedCompanySurfaces);
  ```

  (surface literal per group). Insertion point is ALWAYS immediately AFTER the handler's existing company authz call, so 401/permission errors keep precedence and cross-tenant 404 semantics are unchanged.

**Steps:**

- [ ] Write the failing test `server/src/__tests__/settings-surface-gating-routes.test.ts` (harness copied from `access-routes-permissions-upgrade.test.ts`; actors injected per request app):

  ```ts
  import { randomUUID } from "node:crypto";
  import express from "express";
  import request from "supertest";
  import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
  import {
    activityLog,
    companies,
    companyMemberships,
    createDb,
    principalPermissionGrants,
  } from "@paperclipai/db";
  import {
    closeDbClient,
    getEmbeddedPostgresTestSupport,
    startEmbeddedPostgresTestDatabase,
  } from "./helpers/embedded-postgres.js";
  import { instanceSettingsService } from "../services/instance-settings.js";

  vi.hoisted(() => {
    process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
    process.env.PAPERCLIP_INSTANCE_ID = "vitest";
    process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
    process.env.PAPERCLIP_IN_WORKTREE = "false";
  });

  const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
  const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

  type Db = ReturnType<typeof createDb>;

  function boardActor(input: {
    userId: string;
    companyId: string;
    membershipRole: "owner" | "admin" | "operator" | "viewer";
    isInstanceAdmin?: boolean;
    source?: "session" | "local_implicit";
  }) {
    return {
      type: "board",
      userId: input.userId,
      source: input.source ?? "session",
      isInstanceAdmin: input.isInstanceAdmin ?? false,
      companyIds: [input.companyId],
      memberships: [
        { companyId: input.companyId, membershipRole: input.membershipRole, status: "active" },
      ],
    };
  }

  async function createApp(db: Db, actor: Record<string, unknown>) {
    const { accessRoutes } = await import("../routes/access.js");
    const { secretRoutes } = await import("../routes/secrets.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as never;
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithOwner(db: Db) {
    const company = await db
      .insert(companies)
      .values({
        name: `Surface Gating ${randomUUID()}`,
        issuePrefix: `SG${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const ownerUserId = `owner-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: ownerUserId,
      status: "active",
      membershipRole: "owner",
    });
    return { company, ownerUserId };
  }

  describeEmbeddedPostgres("settings-surface gating on members/invites/secrets routes", () => {
    let db!: Db;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-surface-gating-");
      db = createDb(tempDb.connectionString);
    }, 60_000);

    afterEach(async () => {
      await instanceSettingsService(db).updateVisibility({
        companySurfaces: [
          "company.general",
          "company.members",
          "company.invites",
          "company.secrets",
          "company.plugins",
        ],
      });
      await db.delete(activityLog);
      await db.delete(principalPermissionGrants);
      await db.delete(companyMemberships);
      await db.delete(companies);
    });

    afterAll(async () => {
      await closeDbClient(db);
      await tempDb?.cleanup();
    });

    it("default policy: owners reach members, invites, and secrets routes", async () => {
      const { company, ownerUserId } = await seedCompanyWithOwner(db);
      const app = await createApp(
        db,
        boardActor({ userId: ownerUserId, companyId: company.id, membershipRole: "owner" }),
      );
      await request(app).get(`/api/companies/${company.id}/members`).expect(200);
      await request(app).get(`/api/companies/${company.id}/invites`).expect(200);
      await request(app).get(`/api/companies/${company.id}/secrets`).expect(200);
    });

    it("hidden surfaces: owners get typed surface_not_exposed 403s per surface", async () => {
      const { company, ownerUserId } = await seedCompanyWithOwner(db);
      await instanceSettingsService(db).updateVisibility({ companySurfaces: [] });
      const app = await createApp(
        db,
        boardActor({ userId: ownerUserId, companyId: company.id, membershipRole: "owner" }),
      );

      for (const [path, surface] of [
        [`/api/companies/${company.id}/members`, "company.members"],
        [`/api/companies/${company.id}/join-requests`, "company.members"],
        [`/api/companies/${company.id}/invites`, "company.invites"],
        [`/api/companies/${company.id}/secrets`, "company.secrets"],
        [`/api/companies/${company.id}/secret-providers`, "company.secrets"],
      ] as const) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(403);
        expect(res.body.code, path).toBe("surface_not_exposed");
        expect(res.body.details?.surface, path).toBe(surface);
      }

      const invite = await request(app)
        .post(`/api/companies/${company.id}/invites`)
        .send({});
      expect(invite.status).toBe(403);
      expect(invite.body.code).toBe("surface_not_exposed");
    });

    it("partial policy: exposing company.members only unlocks the members group", async () => {
      const { company, ownerUserId } = await seedCompanyWithOwner(db);
      await instanceSettingsService(db).updateVisibility({
        companySurfaces: ["company.members"],
      });
      const app = await createApp(
        db,
        boardActor({ userId: ownerUserId, companyId: company.id, membershipRole: "owner" }),
      );
      await request(app).get(`/api/companies/${company.id}/members`).expect(200);
      await request(app).get(`/api/companies/${company.id}/invites`).expect(403);
      await request(app).get(`/api/companies/${company.id}/secrets`).expect(403);
    });

    it("instance admins and the local_trusted implicit actor bypass hidden surfaces", async () => {
      const { company, ownerUserId } = await seedCompanyWithOwner(db);
      await instanceSettingsService(db).updateVisibility({ companySurfaces: [] });

      const adminApp = await createApp(
        db,
        boardActor({
          userId: ownerUserId,
          companyId: company.id,
          membershipRole: "owner",
          isInstanceAdmin: true,
        }),
      );
      await request(adminApp).get(`/api/companies/${company.id}/members`).expect(200);
      await request(adminApp).get(`/api/companies/${company.id}/secrets`).expect(200);

      const localApp = await createApp(
        db,
        boardActor({
          userId: ownerUserId,
          companyId: company.id,
          membershipRole: "owner",
          isInstanceAdmin: true,
          source: "local_implicit",
        }),
      );
      await request(localApp).get(`/api/companies/${company.id}/invites`).expect(200);
    });

    it("viewer role matrix: permission denial still precedes the surface gate", async () => {
      const { company } = await seedCompanyWithOwner(db);
      const viewerId = `viewer-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: viewerId,
        status: "active",
        membershipRole: "viewer",
      });
      await instanceSettingsService(db).updateVisibility({ companySurfaces: [] });
      const app = await createApp(
        db,
        boardActor({ userId: viewerId, companyId: company.id, membershipRole: "viewer" }),
      );
      const res = await request(app).get(`/api/companies/${company.id}/members`);
      expect(res.status).toBe(403);
      // Denied by users:manage_permissions BEFORE the surface gate runs; no
      // surface_not_exposed leak for actors who could not use the surface anyway.
      expect(res.body.code).not.toBe("surface_not_exposed");
    });

    it("user directory stays reachable when company.members is hidden (mentions dependency)", async () => {
      const { company, ownerUserId } = await seedCompanyWithOwner(db);
      await instanceSettingsService(db).updateVisibility({ companySurfaces: [] });
      const app = await createApp(
        db,
        boardActor({ userId: ownerUserId, companyId: company.id, membershipRole: "owner" }),
      );
      await request(app).get(`/api/companies/${company.id}/user-directory`).expect(200);
    });
  });
  ```

  NOTE for the implementer: if the invite-create body `{}` fails validation before authz (422/400), switch that sub-assertion to `.send({ allowedJoinTypes: "human" })` — the assertion is the 403 + code, adjust the payload, not the expectation. If `companyMemberships` requires more columns, mirror the insert in `access-routes-permissions-upgrade.test.ts`'s `createCompanyWithOwner`.

- [ ] Run: `cd server && pnpm vitest run src/__tests__/settings-surface-gating-routes.test.ts` — expected: test 1, the viewer test, and the user-directory test pass; the hidden/partial/bypass tests FAIL with `expected 403, got 200` (no gate yet).
- [ ] Implement in `server/src/routes/access.ts`:
  - Import `assertSurfaceExposed` by extending the existing authz import (search for `from "./authz.js"` near the top of route helpers; access.ts imports authz helpers around line 80–90 — add `assertSurfaceExposed` to that list).
  - Inside `accessRoutes`, after `const instanceSettings = instanceSettingsService(db);` (Task 9) add:

    ```ts
    const getExposedCompanySurfaces = async () =>
      (await instanceSettings.getVisibility()).companySurfaces;
    ```

  - Insert `await assertSurfaceExposed(req, "company.invites", getExposedCompanySurfaces);` immediately after the existing authz line in each invites handler:
    - after `await assertCompanyPermission(req, companyId, "users:invite");` at line 3297 (POST `/companies/:companyId/invites`)
    - after `await assertCanGenerateOpenClawInvitePrompt(req, companyId);` at line 3367 (POST `/companies/:companyId/openclaw/invite-prompt`)
    - in POST `/invites/:inviteId/revoke` (line 4116): inside the `else` branch, after `await assertCompanyPermission(req, invite.companyId, "users:invite");` (bootstrap_ceo revokes stay admin-only and ungated)
    - after `await assertCompanyPermission(req, companyId, "users:invite");` at line 4159 (GET `/companies/:companyId/invites`)
  - Insert `await assertSurfaceExposed(req, "company.members", getExposedCompanySurfaces);` immediately after the existing `await assertCompanyPermission(req, companyId, "joins:approve");` / `"users:manage_permissions"` line in each members handler: GET join-requests (4167), approve (4184), reject (4333), GET members (4462), PATCH member (4494), role-and-grants (4591), archive (4718), permissions (4759). (Line numbers shift by earlier insertions — anchor on the `assertCompanyPermission` call inside each named route, not the absolute number.)
- [ ] Implement in `server/src/routes/secrets.ts`:
  - Extend imports: line 19 becomes

    ```ts
    import { assertBoard, assertCompanyAccess, assertSurfaceExposed, getAccessibleResource } from "./authz.js";
    ```

    and line 20 becomes

    ```ts
    import { instanceSettingsService, logActivity, secretService } from "../services/index.js";
    ```

  - Inside `secretRoutes(db)` after `const defaultProvider = getConfiguredSecretProvider();` add:

    ```ts
    const instanceSettingsSvc = instanceSettingsService(db);
    const getExposedCompanySurfaces = async () =>
      (await instanceSettingsSvc.getVisibility()).companySurfaces;
    ```

  - For every `/companies/:companyId/...` management handler listed in Files (NOT `me/user-secrets*`), insert immediately after its `assertCompanyAccess(req, companyId);` or `assertSecretDefinitionAdmin(req, companyId);` line:

    ```ts
    await assertSurfaceExposed(req, "company.secrets", getExposedCompanySurfaces);
    ```

    Representative complete result for GET `/companies/:companyId/secrets` (line 284):

    ```ts
    router.get("/companies/:companyId/secrets", async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await assertSurfaceExposed(req, "company.secrets", getExposedCompanySurfaces);
      const secrets = await svc.list(companyId);
      res.json(secrets);
    });
    ```

    Note: the two non-async handlers at lines 63 and 85-region (`router.get("/companies/:companyId/secret-providers", (req, res) => {` and any other sync handler in the gated set) must become `async (req, res) =>` for the `await`.
  - For the `/secrets/:id*` handlers (rotate 683, patch 723, usage 767, access-events 782, delete 797): insert after the existing `if (!existing) return;` (resource + tenant already verified):

    ```ts
    await assertSurfaceExposed(req, "company.secrets", getExposedCompanySurfaces);
    ```

    Representative complete result for POST `/secrets/:id/rotate`:

    ```ts
    router.post("/secrets/:id/rotate", validate(rotateSecretSchema), async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const fetched = await svc.getById(id);
      const existing = await getAccessibleResource(
        req,
        res,
        fetched && isCompanyScopedSecret(fetched) ? fetched : null,
        "Secret not found",
      );
      if (!existing) return;
      await assertSurfaceExposed(req, "company.secrets", getExposedCompanySurfaces);
      if (existing.status === "deleted") {
        res.status(404).json({ error: "Secret not found" });
        return;
      }
      // … unchanged remainder …
    });
    ```

  - For the `/secret-provider-configs/:id*` handlers (155, 162, 197, 226, 255): open each, find its existing company-access check on the loaded config (`assertCompanyAccess(req, config.companyId)` or equivalent), and insert the same `await assertSurfaceExposed(req, "company.secrets", getExposedCompanySurfaces);` on the next line.
- [ ] Run: `cd server && pnpm vitest run src/__tests__/settings-surface-gating-routes.test.ts` — expected: all 6 pass.
- [ ] Regression sweep: `cd server && pnpm vitest run src/__tests__/access-routes-permissions-upgrade.test.ts src/__tests__/instance-settings-routes.test.ts src/__tests__/cli-auth-me-capabilities.test.ts` plus any existing secrets route tests (`ls src/__tests__ | grep -i secret` and run them) — expected: all pass (default policy exposes everything, so existing tests are unaffected).
- [ ] Run: `cd server && pnpm tsc --noEmit`.
- [ ] Commit:

  ```
  git add server/src/routes/access.ts server/src/routes/secrets.ts server/src/__tests__/settings-surface-gating-routes.test.ts
  git commit -m "feat(server): enforce settings-surface policy on members, invites, and secrets routes

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 11: UI plumbing — `capabilities` type, `useFeatures`/`useBoardCapabilities` hooks

**Files:**
- Modify: `ui/src/api/access.ts` (type import at line 1; `CurrentBoardAccess` at lines 236–253)
- Modify: `ui/src/lib/queryKeys.ts` (instance block at lines 312–317)
- Create: `ui/src/hooks/useFeatures.ts`
- Create: `ui/src/test-utils/currentBoardAccess.ts` (test fixture builder used by every migrated test)
- Test: `ui/src/hooks/useFeatures.test.tsx` (create)

**Interfaces:**
- Consumes: `BoardCapabilities`, `PublicFeatureFlags`, `CompanySettingsSurface`, `COMPANY_SETTINGS_SURFACES` from `@paperclipai/shared`; existing `queryKeys.access.currentBoardAccess` (ui/src/lib/queryKeys.ts:299); `accessApi.getCurrentBoardAccess` (ui/src/api/access.ts:423-424).
- Produces:
  - `CurrentBoardAccess` gains `capabilities: BoardCapabilities;`
  - `useFeatures(): UseQueryResult<PublicFeatureFlags>` — single react-query cache entry keyed `queryKeys.access.currentBoardAccess` with `select`
  - `useBoardCapabilities(): UseQueryResult<CurrentBoardAccess>` — same key, no select (for nav gating: `isInstanceAdmin` + `exposedSurfaces`)
  - `queryKeys.instance.visibilitySettings` (used in Task 14)
  - `buildCurrentBoardAccess(overrides)` test fixture.

**Steps:**

- [ ] Write the failing test `ui/src/hooks/useFeatures.test.tsx` (this is the spec §7 "migration test for the UI's switch to capabilities.features" at the hook level; jsdom + createRoot pattern as in `CompanySettingsSidebar.test.tsx:1-103`):

  ```tsx
  // @vitest-environment jsdom

  import { createRoot } from "react-dom/client";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

  const mockAccessApi = vi.hoisted(() => ({
    getCurrentBoardAccess: vi.fn(),
  }));

  vi.mock("@/api/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/api/access")>()),
    accessApi: mockAccessApi,
  }));

  import { useFeatures } from "./useFeatures";
  import { buildCurrentBoardAccess } from "@/test-utils/currentBoardAccess";

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  async function flush() {
    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }

  function Probe() {
    const { data } = useFeatures();
    return <div data-testid="probe">{data ? `cases:${data.enableCases}` : "loading"}</div>;
  }

  describe("useFeatures", () => {
    let container: HTMLDivElement;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
    });

    afterEach(() => {
      container.remove();
      document.body.innerHTML = "";
      vi.clearAllMocks();
    });

    it("selects capabilities.features from /cli-auth/me", async () => {
      mockAccessApi.getCurrentBoardAccess.mockResolvedValue(
        buildCurrentBoardAccess({ features: { enableCases: true } }),
      );
      const root = createRoot(container);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
      await flush();

      expect(container.textContent).toContain("cases:true");
      expect(mockAccessApi.getCurrentBoardAccess).toHaveBeenCalledTimes(1);

      root.unmount();
    });
  });
  ```

- [ ] Run: `cd ui && pnpm vitest run src/hooks/useFeatures.test.tsx` — expected failure: `Cannot find module './useFeatures'` (and `@/test-utils/currentBoardAccess`).
- [ ] Implement `ui/src/api/access.ts`:
  - Line 1: `import type { AgentAdapterType, JoinRequest, PermissionKey } from "@paperclipai/shared";` → `import type { AgentAdapterType, BoardCapabilities, JoinRequest, PermissionKey } from "@paperclipai/shared";`
  - Add to `CurrentBoardAccess` (after the `cloudStack` field at line 252):

    ```ts
    /** Server-derived UI capabilities: exposed settings surfaces, public
     *  feature flags, and (from PR-3) effective company standings. */
    capabilities: BoardCapabilities;
    ```

- [ ] Implement `ui/src/hooks/useFeatures.ts`:

  ```ts
  import { useQuery } from "@tanstack/react-query";
  import type { CurrentBoardAccess } from "@/api/access";
  import { accessApi } from "@/api/access";
  import { queryKeys } from "@/lib/queryKeys";

  /**
   * Board access + capabilities from GET /cli-auth/me. Single cache entry
   * (queryKeys.access.currentBoardAccess) shared by nav gating and feature
   * flags. Degrades closed: consumers must treat `undefined` data as
   * "nothing exposed / no features enabled".
   */
  export function useBoardCapabilities() {
    return useQuery({
      queryKey: queryKeys.access.currentBoardAccess,
      queryFn: () => accessApi.getCurrentBoardAccess(),
      staleTime: 30_000,
      retry: false,
    });
  }

  /**
   * Public feature flags for the signed-in board user. Replaces every
   * non-admin read of /instance/settings, /general, /experimental — those
   * endpoints are instance-admin-only as of PR-1 (settings-surface policy).
   */
  export function useFeatures() {
    return useQuery({
      queryKey: queryKeys.access.currentBoardAccess,
      queryFn: () => accessApi.getCurrentBoardAccess(),
      staleTime: 30_000,
      retry: false,
      select: (access: CurrentBoardAccess) => access.capabilities.features,
    });
  }
  ```

- [ ] Implement `ui/src/test-utils/currentBoardAccess.ts`:

  ```ts
  import type { BoardCapabilities, PublicFeatureFlags } from "@paperclipai/shared";
  import { COMPANY_SETTINGS_SURFACES } from "@paperclipai/shared";
  import type { CurrentBoardAccess } from "@/api/access";

  export const DEFAULT_PUBLIC_FEATURES: PublicFeatureFlags = {
    enableEnvironments: false,
    enableIsolatedWorkspaces: false,
    enableApps: false,
    enablePipelines: false,
    enableCases: false,
    enableConferenceRoomChat: false,
    enableTaskWatchdogs: false,
    enableIssuePlanDecompositions: false,
    enableExperimentalFileViewer: false,
    enableCloudSync: false,
    enableExternalObjects: false,
    enableSmokeLab: false,
    enableBuiltInAgents: false,
    enableDecisions: false,
    enableGoalsSidebarLink: false,
    enableServerInfoDebugView: false,
    cloudBilling: false,
    cloudTrialBanner: false,
    keyboardShortcuts: false,
    censorUsernameInLogs: false,
    feedbackDataSharingPreference: "prompt",
    executionMode: "any",
    defaultEnvironmentId: null,
  };

  export function buildCurrentBoardAccess(overrides?: {
    isInstanceAdmin?: boolean;
    exposedSurfaces?: BoardCapabilities["exposedSurfaces"];
    features?: Partial<PublicFeatureFlags>;
    companyIds?: string[];
    memberships?: CurrentBoardAccess["memberships"];
  }): CurrentBoardAccess {
    return {
      user: { id: "user-1", email: "user@example.com", name: "User One", image: null },
      userId: "user-1",
      isInstanceAdmin: overrides?.isInstanceAdmin ?? false,
      companyIds: overrides?.companyIds ?? ["company-1"],
      memberships:
        overrides?.memberships ??
        [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
      source: "session",
      keyId: null,
      cloudStack: null,
      capabilities: {
        exposedSurfaces: overrides?.exposedSurfaces ?? [...COMPANY_SETTINGS_SURFACES],
        features: { ...DEFAULT_PUBLIC_FEATURES, ...overrides?.features },
        companyStandings: {},
      },
    };
  }
  ```

- [ ] Add to `ui/src/lib/queryKeys.ts` inside the `instance:` block (lines 312–317), after `experimentalSettings`:

  ```ts
      visibilitySettings: ["instance", "visibility-settings"] as const,
  ```

- [ ] Run: `cd ui && pnpm vitest run src/hooks/useFeatures.test.tsx` — expected: 1 passed. Then `cd ui && pnpm tsc --noEmit` — NOTE: expect NO new errors from this task; consumers still compile because `capabilities` is additive.
- [ ] Commit:

  ```
  git add ui/src/api/access.ts ui/src/hooks/useFeatures.ts ui/src/hooks/useFeatures.test.tsx ui/src/test-utils/currentBoardAccess.ts ui/src/lib/queryKeys.ts
  git commit -m "feat(ui): capabilities on CurrentBoardAccess + useFeatures/useBoardCapabilities hooks

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 12: UI migration — every non-admin `/instance/settings*` read moves to `capabilities.features`

Mechanical migration of all 30 non-admin `getExperimental()` call sites, 6 non-admin `getGeneral()` call sites, and 3 non-admin full `get()` call sites to `useFeatures()`. The two admin pages keep the admin API: `ui/src/pages/InstanceExperimentalSettings.tsx` and `ui/src/pages/InstanceGeneralSettings.tsx` (their reads are now admin-only server-side, which matches their audience; their nav entries are admin-gated in Task 13).

Canonical replacement — every entry below applies this exact pattern:

```ts
// OLD (variable name varies per file; options like retry/enabled are dropped —
// useFeatures centralizes retry:false + staleTime, and /cli-auth/me is cached):
const { data: experimentalSettings } = useQuery({
  queryKey: queryKeys.instance.experimentalSettings,
  queryFn: () => instanceSettingsApi.getExperimental(),
  retry: false,
});

// NEW (keep the ORIGINAL destructured variable name so downstream reads compile unchanged):
const { data: experimentalSettings } = useFeatures();
```

plus per file: add `import { useFeatures } from "@/hooks/useFeatures";` (use a relative path `../hooks/useFeatures` in files that import siblings relatively) and remove `instanceSettingsApi` / `useQuery` / `queryKeys` imports IF now unused in that file (most files still use `useQuery`/`queryKeys` for other queries — check per file, the linter/typechecker will flag).

**Files (Modify — exhaustive; line numbers are pre-edit anchors):**

Experimental reads → `useFeatures()`, keeping the file's variable name:

| # | File | Query block | Kept variable | Flags read |
|---|------|-------------|---------------|------------|
| 1 | `ui/src/components/AgentConfigForm.tsx` | 234–238 | `experimentalSettings` | enableEnvironments |
| 2 | `ui/src/components/CasesExperimentalGate.tsx` | 12–15 | `experimentalSettings, isFetched` | enableCases |
| 3 | `ui/src/components/CloudTrialBanner.tsx` | 43–46 | `experimentalSettings` | cloudTrialBanner |
| 4 | `ui/src/components/CommandPalette.tsx` | 100–104 | `experimentalSettings` | enableExperimentalFileViewer |
| 5 | `ui/src/components/CompanySettingsSidebar.tsx` | 70–73 | (superseded in Task 13 — skip here) | enableCloudSync |
| 6 | `ui/src/components/issue-properties/IssueProperties.tsx` | 148–151 | `experimentalSettings` | enableTaskWatchdogs |
| 7 | `ui/src/components/IssueCasesPanel.tsx` | 23–26 | `experimentalSettings` | enableCases |
| 8 | `ui/src/components/IssuesList.tsx` | 693–697 | `experimentalSettings` | enableIsolatedWorkspaces, enableExternalObjects |
| 9 | `ui/src/components/IssueWorkspaceCard.tsx` | 208–211 | `experimentalSettings` | enableEnvironments, enableIsolatedWorkspaces |
| 10 | `ui/src/components/NewIssueDialog.tsx` | 515–520 | `experimentalSettings` | enableIsolatedWorkspaces |
| 11 | `ui/src/components/PipelinesExperimentalGate.tsx` | 8–11 | `experimentalSettings, isFetched` | enablePipelines |
| 12 | `ui/src/components/ProjectProperties.tsx` | 249–253 | `experimentalSettings` | enableEnvironments, enableIsolatedWorkspaces |
| 13 | `ui/src/components/RoutineRunVariablesDialog.tsx` | 251–255 | `experimentalSettings` | enableIsolatedWorkspaces |
| 14 | `ui/src/components/Sidebar.tsx` | 61–64 | `experimentalSettings` | enableIsolatedWorkspaces, enableApps, enablePipelines, enableGoalsSidebarLink, enableDecisions |
| 15 | `ui/src/components/SidebarAccountMenu.tsx` | 148–151 | `experimentalSettings` | cloudBilling |
| 16 | `ui/src/components/SidebarServerInfo.tsx` | 81–84 | `experimentalQuery` (rename block: `const experimentalQuery = useFeatures();`) | enableServerInfoDebugView |
| 17 | `ui/src/hooks/useAppsEnabled.ts` | 6–9 | `query` (`const query = useFeatures();`) | enableApps |
| 18 | `ui/src/hooks/useConferenceRoomChatEnabled.ts` | 33–39 | see custom-client note below | enableConferenceRoomChat |
| 19 | `ui/src/hooks/useIssueExternalObjects.ts` | 71–75 | `query` (`const query = useFeatures();`) | enableExternalObjects |
| 20 | `ui/src/hooks/useSmokeLabEnabled.ts` | 33–39 | see custom-client note below | enableSmokeLab |
| 21 | `ui/src/pages/AgentDetail.tsx` | 737–741 | `experimentalSettings` | enableBuiltInAgents |
| 22 | `ui/src/pages/CloudUpstream.tsx` | 85–88 | `experimentalQuery` (`const experimentalQuery = useFeatures();`) | enableCloudSync |
| 23 | `ui/src/pages/CompanyEnvironments.tsx` | 1180–1184 | `experimentalSettings` | enableEnvironments |
| 24 | `ui/src/pages/CompanySettings.tsx` | 34–37 | `experimentalSettings` | enableCloudSync |
| 25 | `ui/src/pages/Costs.tsx` | 213–216 | `experimentalSettings` | cloudBilling |
| 26 | `ui/src/pages/Inbox.tsx` | 695–699 | `experimentalSettings` | enableIsolatedWorkspaces, enableExternalObjects |
| 27 | `ui/src/pages/IssueDetail.tsx` | 1763–1768 | `instanceExperimentalSettings` | enableCases, enableIssuePlanDecompositions, enableExperimentalFileViewer |
| 28 | `ui/src/pages/PipelineSettings.tsx` | 1350–1354 | `experimentalSettingsQuery` (`const experimentalSettingsQuery = useFeatures();`) | enableIsolatedWorkspaces |
| 29 | `ui/src/pages/ProjectDetail.tsx` | 410–413 | `experimentalSettingsQuery` (`const experimentalSettingsQuery = useFeatures();`) | enableIsolatedWorkspaces |
| 30 | `ui/src/pages/Workspaces.tsx` | 81–84 | `experimentalSettingsQuery` (`const experimentalSettingsQuery = useFeatures();`) | enableIsolatedWorkspaces |

General reads → `useFeatures()` (fields exist on `PublicFeatureFlags` with the same names, so downstream reads compile unchanged):

| File | Query block | Kept variable | Fields read |
|------|-------------|---------------|-------------|
| `ui/src/components/Layout.tsx` | 188–191 | inline: `const keyboardShortcutsEnabled = useFeatures().data?.keyboardShortcuts === true;` | keyboardShortcuts |
| `ui/src/components/AgentConfigForm.tsx` | 245–249 | `generalSettings` (`const { data: generalSettings } = useFeatures();`) | executionMode |
| `ui/src/components/transcript/useLiveRunTranscripts.ts` | 150–153 | `generalSettings` | censorUsernameInLogs |
| `ui/src/pages/AgentDetail.tsx` | 3864–3867 | inline: `const censorUsernameInLogs = useFeatures().data?.censorUsernameInLogs === true;` | censorUsernameInLogs |
| `ui/src/pages/IssueDetail.tsx` | 1757–1762 | `instanceGeneralSettings` (`const { data: instanceGeneralSettings } = useFeatures();`) | keyboardShortcuts, feedbackDataSharingPreference |
| `ui/src/pages/Pipelines.tsx` | 2113–2118 | `instanceGeneralSettings` (`const { data: instanceGeneralSettings } = useFeatures();`) | feedbackDataSharingPreference (line 2120 compiles unchanged) |

Full `instanceSettingsApi.get()` reads → `useFeatures()`:

| File | Query block | Edit |
|------|-------------|------|
| `ui/src/components/AgentConfigForm.tsx` | 250–254 | Delete the `instanceSettings` query entirely; at line 443 change `const environmentId = instanceSettings?.defaultEnvironmentId ?? null;` to `const environmentId = generalSettings?.defaultEnvironmentId ?? null;` (and line 447 dep array `instanceSettings?.defaultEnvironmentId` → `generalSettings?.defaultEnvironmentId`) — `generalSettings` is now the `useFeatures()` data from the row above. |
| `ui/src/pages/Agents.tsx` | 201–206 | Replace with `const { data: instanceSettings } = useFeatures();` and change line 207 `instanceSettings?.experimental.enableBuiltInAgents === true` → `instanceSettings?.enableBuiltInAgents === true`. |
| `ui/src/pages/CompanyEnvironments.tsx` | 1174–1178 | Replace with `const { data: instanceSettings } = useFeatures();`; line 1555 `instanceSettings?.defaultEnvironmentId ?? null` compiles unchanged. At line 1276, extend the existing invalidation to also refresh capabilities: add `await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });` after the `queryKeys.instance.settings` invalidation (the make-default mutation is admin-only and still PATCHes `/instance/settings`). |

Invalidation touch-ups (stale features after admin edits):
- `ui/src/pages/IssueDetail.tsx:2981`: replace `queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });` with `queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });`
- `ui/src/pages/InstanceExperimentalSettings.tsx` and `ui/src/pages/InstanceGeneralSettings.tsx`: find each mutation `onSuccess` that invalidates `queryKeys.instance.experimentalSettings` / `queryKeys.instance.generalSettings` (grep `invalidateQueries` in both files) and ADD `queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });` beside it (keep the existing invalidations — the admin pages still read the admin endpoints).

Custom-client hooks (#18, #20) keep their two-argument `useQuery(options, client)` form — replace only key/fn and add select. Complete result for `ui/src/hooks/useSmokeLabEnabled.ts` (lines 33–39; `useConferenceRoomChatEnabled.ts` is identical except the flag):

```ts
const { data, isFetched } = useQuery(
  {
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: contextClient != null,
    select: (access) => access.capabilities.features,
  },
  contextClient ?? getDetachedClient(),
);
```

(then `data?.enableSmokeLab === true` at line 44 compiles unchanged; swap the `instanceSettingsApi` import for `import { accessApi } from "@/api/access";` — match the file's existing import style).

**Test files (Modify):** every test that mocks `instanceSettingsApi.getExperimental`/`getGeneral` for a migrated component now mocks `@/api/access` instead, using the Task 11 fixture. Canonical mock replacement:

```ts
// OLD
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
// beforeEach:
mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableCloudSync: false });

// NEW
const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
// beforeEach:
mockAccessApi.getCurrentBoardAccess.mockResolvedValue(
  buildCurrentBoardAccess({ features: { enableCloudSync: false } }),
);
// import { buildCurrentBoardAccess } from "@/test-utils/currentBoardAccess";
```

Apply to (skip `InstanceExperimentalSettings.test.tsx` — admin page unchanged; `CompanySettingsSidebar.test.tsx` is rewritten in Task 13): `AgentConfigForm.render.test.tsx`, `AppsExperimentalGate.test.tsx`, `CloudTrialBanner.test.tsx`, `CommandPalette.test.tsx`, `ConferenceRoomChatGate.test.tsx`, `IssueCasesPanel.test.tsx`, `IssueProperties.test.tsx`, `IssuesList.test.tsx`, `Layout.test.tsx`, `NewIssueDialog.test.tsx`, `OnboardingWizard.test.tsx`, `OnboardingWizardVariant.test.tsx`, `PipelinesExperimentalGate.test.tsx`, `RoutineRunVariablesDialog.test.tsx`, `Sidebar.test.tsx`, `SidebarAccountMenu.test.tsx`, `SidebarProjects.test.tsx`, `SidebarServerInfo.test.tsx`, `SmokeLabDashboardCard.test.tsx`, `transcript/useLiveRunTranscripts.test.tsx`, `pages/CloudUpstream.test.tsx`, `pages/CompanyEnvironments.test.tsx`, `pages/CompanySettings.test.tsx`, `pages/Inbox.test.tsx`, `pages/IssueDetail.test.tsx`, `pages/ProjectDetail.test.tsx`, `pages/Routines.test.tsx`, `pages/tools/SmokeLabTab.test.tsx`, `pages/Workspaces.test.tsx`. In files where an existing mock of `@/api/access` already exists, extend it with `getCurrentBoardAccess` instead of adding a second `vi.mock`. Translate each old per-test flag override (`getExperimental.mockResolvedValue({ enableX: true })`) to `buildCurrentBoardAccess({ features: { enableX: true } })`; translate `getGeneral.mockResolvedValue({ keyboardShortcuts: true })` to `buildCurrentBoardAccess({ features: { keyboardShortcuts: true } })`.

**Interfaces:**
- Consumes: `useFeatures` (Task 11).
- Produces: zero non-admin references to `instanceSettingsApi.get/getGeneral/getExperimental` (verified by the guard test below).

**Steps:**

- [ ] Write the failing migration guard test `ui/src/lib/features-migration-guard.test.ts` (node env — no jsdom banner):

  ```ts
  import { readdirSync, readFileSync, statSync } from "node:fs";
  import { dirname, join } from "node:path";
  import { fileURLToPath } from "node:url";
  import { describe, expect, it } from "vitest";

  const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

  // Admin-only surfaces that legitimately keep the admin instance-settings API.
  const ALLOWLIST = new Set([
    join(SRC_ROOT, "api", "instanceSettings.ts"),
    join(SRC_ROOT, "pages", "InstanceExperimentalSettings.tsx"),
    join(SRC_ROOT, "pages", "InstanceGeneralSettings.tsx"),
    join(SRC_ROOT, "pages", "InstanceAccess.tsx"),
    join(SRC_ROOT, "components", "access", "CompanySurfaceVisibilityCard.tsx"),
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }

  describe("capabilities.features migration guard", () => {
    it("no non-admin source file reads /instance/settings directly", () => {
      const offenders = walk(SRC_ROOT).filter((file) => {
        if (ALLOWLIST.has(file)) return false;
        const text = readFileSync(file, "utf8");
        return /instanceSettingsApi\.(get|getGeneral|getExperimental)\(/.test(text);
      });
      expect(offenders).toEqual([]);
    });
  });
  ```

- [ ] Run: `cd ui && pnpm vitest run src/lib/features-migration-guard.test.ts` — expected failure: `offenders` lists ~33 files.
- [ ] Apply the source migrations from the three tables + custom-client note + invalidation touch-ups above, file by file. After each file: `cd ui && pnpm tsc --noEmit 2>&1 | grep <file>` should be clean.
- [ ] Apply the test-mock migration to the listed test files.
- [ ] Run: `cd ui && pnpm vitest run src/lib/features-migration-guard.test.ts` — expected: pass (offender list empty; note the two Task 13/14 allowlisted files may not exist yet — that is fine, `ALLOWLIST` is by path only).
- [ ] Run the full UI suite: `cd ui && pnpm vitest run` — expected: everything green except pre-existing unrelated flakes; every test file listed above must pass.
- [ ] Run: `cd ui && pnpm tsc --noEmit` — expected: clean.
- [ ] Commit:

  ```
  git add ui/src
  git commit -m "refactor(ui): migrate all non-admin instance-settings reads to capabilities.features

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 13: Nav gating — sidebar, tab nav, and `surface_not_exposed` navigation misses

**Files:**
- Modify: `ui/src/components/CompanySettingsSidebar.tsx` (query at lines 70–78; company entries at lines 106–136; instance section at lines 137–207)
- Modify: `ui/src/components/access/CompanySettingsNav.tsx` (static `items` at lines 6–20; component at lines 80–101; `getCompanySettingsTab` stays untouched)
- Create: `ui/src/components/access/SurfaceGuard.tsx`
- Modify: `ui/src/App.tsx` (routes at lines 107, 109, 112)
- Test: `ui/src/components/CompanySettingsSidebar.test.tsx` (rewrite mocks + add role cases)
- Test: `ui/src/components/access/CompanySettingsNav.test.tsx` (extend: filtered items)
- Test: `ui/src/components/access/SurfaceGuard.test.tsx` (create)

**Interfaces:**
- Consumes: `useBoardCapabilities` (Task 11); `CompanySettingsSurface` type from `@paperclipai/shared`; existing `SidebarNavItem`, `usePluginSlots`, `queryKeys`.
- Produces:
  - Sidebar/nav render company entries from `capabilities.exposedSurfaces`; Instance section/tabs only when `isInstanceAdmin === true` (payload value — true for `local_implicit` per Task 9).
  - Degrade-closed: while `capabilities` is unloaded or errored, gated entries are hidden; the already-rendered page is never blocked (spec §6).
  - `SurfaceGuard` redirects `surface_not_exposed` navigation misses to `/company/settings`.

**Steps:**

- [ ] Rewrite `ui/src/components/CompanySettingsSidebar.test.tsx` mocks first (failing tests): replace the `mockInstanceSettingsApi` hoist + `vi.mock("@/api/instanceSettings", …)` (lines 12–14, 77–79) with the Task 11/12 access mock, and set `beforeEach` default to `buildCurrentBoardAccess({ isInstanceAdmin: true })` so the two existing structural tests (all entries incl. Instance section) keep passing. Update the two cloud-upstream tests to `mockAccessApi.getCurrentBoardAccess.mockResolvedValue(buildCurrentBoardAccess({ isInstanceAdmin: true, features: { enableCloudSync: true } }))`. Then ADD:

  ```tsx
  it("company member: renders only exposed company surfaces and no instance section", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(
      buildCurrentBoardAccess({
        isInstanceAdmin: false,
        exposedSurfaces: ["company.general", "company.members"],
      }),
    );
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Members");
    expect(container.textContent).not.toContain("Invites");
    expect(container.textContent).not.toContain("Secrets");
    expect(container.textContent).not.toContain("Instance settings");
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "/company/settings/instance/general" }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("instance admin: sees every company surface and the instance section regardless of policy", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(
      buildCurrentBoardAccess({ isInstanceAdmin: true }),
    );
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Invites");
    expect(container.textContent).toContain("Secrets");
    expect(container.textContent).toContain("Instance settings");

    await act(async () => {
      root.unmount();
    });
  });

  it("degrades closed: gated entries hidden while capabilities are unavailable", async () => {
    mockAccessApi.getCurrentBoardAccess.mockRejectedValue(new Error("offline"));
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).not.toContain("Members");
    expect(container.textContent).not.toContain("Instance settings");
    // The chrome itself still renders — the page is not blocked.
    expect(container.textContent).toContain("Company Settings");

    await act(async () => {
      root.unmount();
    });
  });

  it("enabled plugins' companySettingsPage entries render even when the policy hides everything", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(
      buildCurrentBoardAccess({ isInstanceAdmin: false, exposedSurfaces: [] }),
    );
    mockUsePluginSlots.mockReturnValue({
      slots: [
        {
          type: "companySettingsPage",
          id: "billing",
          displayName: "Billing",
          exportName: "BillingPage",
          routePath: "billing",
          pluginId: "plugin-billing",
          pluginKey: "billing",
          pluginDisplayName: "Billing",
          pluginVersion: "0.1.0",
        },
      ],
      isLoading: false,
      errorMessage: null,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Billing");

    await act(async () => {
      root.unmount();
    });
  });
  ```

- [ ] Run: `cd ui && pnpm vitest run src/components/CompanySettingsSidebar.test.tsx` — expected: new tests fail (component still renders everything statically).
- [ ] Implement `ui/src/components/CompanySettingsSidebar.tsx`:
  - Replace the experimental query (lines 70–73) with:

    ```ts
    const { data: boardAccess } = useBoardCapabilities();
    const exposedSurfaces = new Set(boardAccess?.capabilities.exposedSurfaces ?? []);
    const isInstanceAdmin = boardAccess?.isInstanceAdmin === true;
    ```

    (import `useBoardCapabilities` from `@/hooks/useFeatures`; drop the `instanceSettingsApi` import — line 20; keep `useQuery`/`queryKeys` for the badges/plugins queries.)
  - Line 78: `const showCloudUpstream = experimentalSettings?.enableCloudSync === true;` → `const showCloudUpstream = boardAccess?.capabilities.features.enableCloudSync === true;`
  - Company section (lines 106–136): wrap each static entry in its surface check (plugin `companySettingsPage` slots at 123–133 stay UNGATED — spec §3.1: pages of already-enabled plugins render regardless):
    - General (line 107): `{exposedSurfaces.has("company.general") ? (<SidebarNavItem to="/company/settings" label="General" icon={SlidersHorizontal} end />) : null}`
    - Members (lines 116–122): wrap in `{exposedSurfaces.has("company.members") ? ( … ) : null}`
    - Invites (line 134): wrap in `{exposedSurfaces.has("company.invites") ? ( … ) : null}`
    - Secrets (line 135): wrap in `{exposedSurfaces.has("company.secrets") ? ( … ) : null}`
    - (`company.plugins` has no company-catalog page until PR-2 — nothing to render yet.)
  - Instance section (lines 137–207): wrap the ENTIRE block — the "Instance settings" heading div AND the entries div — in `{isInstanceAdmin ? (<> … </>) : null}`. The Profile entry (lines 141–146) is per-user (spec §3.1 "always visible"): MOVE it out of the instance block and render it after the company section under its own non-gated block:

    ```tsx
    <div className="mt-5 px-3 pb-1 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
      My settings
    </div>
    <div className="flex flex-col gap-0.5">
      <SidebarNavItem
        to={`${INSTANCE_SETTINGS_PATH_PREFIX}/profile`}
        label="Profile"
        icon={UserRoundPen}
        end
      />
    </div>
    ```

    Update the existing structural test's Profile expectation if it asserted section placement (it asserts only the `to`/`label` props — no change needed).
- [ ] Run: `cd ui && pnpm vitest run src/components/CompanySettingsSidebar.test.tsx` — expected: all pass.
- [ ] Implement `ui/src/components/access/CompanySettingsNav.tsx`: keep the `items` const and `getCompanySettingsTab` exactly as-is for the type + mapping, and filter at render:

  ```tsx
  import { useMemo } from "react";
  import { PageTabBar } from "@/components/PageTabBar";
  import { Tabs } from "@/components/ui/tabs";
  import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";
  import { useLocation, useNavigate } from "@/lib/router";
  import { useBoardCapabilities } from "@/hooks/useFeatures";
  ```

  Inside the component:

  ```tsx
  export function CompanySettingsNav() {
    const location = useLocation();
    const navigate = useNavigate();
    const activeTab = getCompanySettingsTab(location.pathname);
    const { data: boardAccess } = useBoardCapabilities();
    const exposedSurfaces = new Set(boardAccess?.capabilities.exposedSurfaces ?? []);
    const isInstanceAdmin = boardAccess?.isInstanceAdmin === true;
    const cloudSyncEnabled = boardAccess?.capabilities.features.enableCloudSync === true;

    const visibleItems = useMemo(
      () =>
        items.filter((item) => {
          if (item.value === "general") return exposedSurfaces.has("company.general");
          if (item.value === "cloud-upstream") return cloudSyncEnabled;
          if (item.value === "members") return exposedSurfaces.has("company.members");
          if (item.value === "invites") return exposedSurfaces.has("company.invites");
          if (item.value === "secrets") return exposedSurfaces.has("company.secrets");
          if (item.value === "instance-profile") return true; // per-user, always visible
          return isInstanceAdmin; // all remaining instance-* tabs
        }),
      [boardAccess, cloudSyncEnabled, isInstanceAdmin], // exposedSurfaces derives from boardAccess
    );

    function handleTabChange(value: string) {
      const nextTab = visibleItems.find((item) => item.value === value);
      if (!nextTab || nextTab.value === activeTab) return;
      navigate(nextTab.href);
    }

    return (
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <PageTabBar
          items={visibleItems.map(({ value, label }) => ({ value, label }))}
          value={activeTab}
          onValueChange={handleTabChange}
          align="start"
        />
      </Tabs>
    );
  }
  ```

- [ ] Extend `ui/src/components/access/CompanySettingsNav.test.tsx`: the existing file has NO react-query provider and no access mock — add the same `mockAccessApi` hoist + `vi.mock("@/api/access", …)` + wrap renders in `QueryClientProvider` (mirror the sidebar test), defaulting to `buildCurrentBoardAccess({ isInstanceAdmin: true })` in `beforeEach` so existing assertions still see all tabs. The existing sync `flushSync`-based `act` cannot await the query — add the sidebar test's async `act`/`flushReact` helpers (copy from `CompanySettingsSidebar.test.tsx:92-103`) for the new test and use them when the existing rendering tests start failing on timing. Add:

  ```tsx
  it("filters tabs by exposed surfaces and admin status", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(
      buildCurrentBoardAccess({
        isInstanceAdmin: false,
        exposedSurfaces: ["company.general", "company.secrets"],
      }),
    );
    currentPathname = "/company/settings";
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsNav />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const rendered = pageTabBarMock.mock.calls.at(-1)?.[0] as {
      items: Array<{ value: string }>;
    };
    expect(rendered.items.map((item) => item.value)).toEqual([
      "general",
      "secrets",
      "instance-profile",
    ]);

    await act(async () => {
      root.unmount();
    });
  });
  ```
- [ ] Create `ui/src/components/access/SurfaceGuard.tsx` — treats hidden-surface entries as navigation misses (spec §6): redirect to the company settings root when capabilities are KNOWN and the surface is hidden; while unknown/errored, render children (never block the loaded page — the server still enforces):

  ```tsx
  import type { ReactNode } from "react";
  import type { CompanySettingsSurface } from "@paperclipai/shared";
  import { Navigate } from "@/lib/router";
  import { useBoardCapabilities } from "@/hooks/useFeatures";

  /**
   * Navigation-miss guard for company settings surfaces (PR-1). If the loaded
   * capabilities say the surface is hidden, redirect to the company settings
   * root instead of rendering a page whose API calls will 403 with
   * surface_not_exposed. While capabilities are loading or failed we render
   * the page (server-side enforcement remains authoritative).
   */
  export function SurfaceGuard({
    surface,
    children,
  }: {
    surface: CompanySettingsSurface;
    children: ReactNode;
  }) {
    const { data: boardAccess } = useBoardCapabilities();
    if (boardAccess && !boardAccess.capabilities.exposedSurfaces.includes(surface)) {
      return <Navigate to="/company/settings" replace />;
    }
    return <>{children}</>;
  }
  ```

  (Verify `Navigate` is exported from `@/lib/router` — App.tsx line 105 already uses `<Navigate to=… replace />`; import it from the same module App.tsx does.)
- [ ] Test — create `ui/src/components/access/SurfaceGuard.test.tsx` (complete file):

  ```tsx
  // @vitest-environment jsdom

  import { createRoot } from "react-dom/client";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
  import { buildCurrentBoardAccess } from "@/test-utils/currentBoardAccess";

  const mockAccessApi = vi.hoisted(() => ({
    getCurrentBoardAccess: vi.fn(),
  }));

  vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));

  vi.mock("@/lib/router", () => ({
    Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
  }));

  import { SurfaceGuard } from "./SurfaceGuard";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  async function act(callback: () => void | Promise<void>) {
    await callback();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  async function flushReact() {
    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }

  describe("SurfaceGuard", () => {
    let container: HTMLDivElement;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
    });

    afterEach(() => {
      container.remove();
      document.body.innerHTML = "";
      vi.clearAllMocks();
    });

    async function renderGuard() {
      const root = createRoot(container);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <SurfaceGuard surface="company.members">
              <div>page</div>
            </SurfaceGuard>
          </QueryClientProvider>,
        );
      });
      await flushReact();
      return root;
    }

    it("renders children when the surface is exposed", async () => {
      mockAccessApi.getCurrentBoardAccess.mockResolvedValue(buildCurrentBoardAccess({}));
      const root = await renderGuard();
      expect(container.textContent).toContain("page");
      expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
      await act(async () => root.unmount());
    });

    it("redirects to the settings root when the surface is hidden", async () => {
      mockAccessApi.getCurrentBoardAccess.mockResolvedValue(
        buildCurrentBoardAccess({ exposedSurfaces: [] }),
      );
      const root = await renderGuard();
      expect(container.textContent).toContain("/company/settings");
      expect(container.textContent).not.toContain("page");
      await act(async () => root.unmount());
    });

    it("renders children while capabilities are unavailable (server enforces)", async () => {
      mockAccessApi.getCurrentBoardAccess.mockRejectedValue(new Error("offline"));
      const root = await renderGuard();
      expect(container.textContent).toContain("page");
      await act(async () => root.unmount());
    });
  });
  ```
- [ ] Wire the guard in `ui/src/App.tsx`: import `{ SurfaceGuard }` from `@/components/access/SurfaceGuard` and change:
  - line 107: `<Route path="company/settings/members" element={<SurfaceGuard surface="company.members"><CompanyAccess /></SurfaceGuard>} />`
  - line 109: `<Route path="company/settings/invites" element={<SurfaceGuard surface="company.invites"><CompanyInvites /></SurfaceGuard>} />`
  - line 112: `<Route path="company/settings/secrets" element={<SurfaceGuard surface="company.secrets"><Secrets /></SurfaceGuard>} />`
- [ ] Run: `cd ui && pnpm vitest run src/components/CompanySettingsSidebar.test.tsx src/components/access/CompanySettingsNav.test.tsx src/components/access/SurfaceGuard.test.tsx src/App.test.tsx` — expected: all pass (App.test may need the access mock extended with `getCurrentBoardAccess` returning `buildCurrentBoardAccess({ isInstanceAdmin: true })` if it renders these routes).
- [ ] Run: `cd ui && pnpm tsc --noEmit`.
- [ ] Commit:

  ```
  git add ui/src/components/CompanySettingsSidebar.tsx ui/src/components/CompanySettingsSidebar.test.tsx ui/src/components/access/CompanySettingsNav.tsx ui/src/components/access/CompanySettingsNav.test.tsx ui/src/components/access/SurfaceGuard.tsx ui/src/components/access/SurfaceGuard.test.tsx ui/src/App.tsx
  git commit -m "feat(ui): capabilities-driven company settings nav with surface guard redirects

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 14: Admin UI — "Company settings visibility" card on Instance Access

**Files:**
- Modify: `ui/src/api/instanceSettings.ts` (append two functions)
- Create: `ui/src/components/access/CompanySurfaceVisibilityCard.tsx`
- Modify: `ui/src/pages/InstanceAccess.tsx` (mount the card after the existing grid, i.e. after line 248's closing `</div>` of the grid)
- Test: `ui/src/components/access/CompanySurfaceVisibilityCard.test.tsx` (create)

**Interfaces:**
- Consumes: `GET/PATCH /instance/settings/visibility` (Task 6); `COMPANY_SETTINGS_SURFACES`, `CompanySettingsSurface`, `InstanceVisibilitySettings`, `PatchInstanceVisibilitySettings` from `@paperclipai/shared`; `queryKeys.instance.visibilitySettings` and `queryKeys.access.currentBoardAccess` (Task 11); `Card`, `Checkbox`, `Button`, `useToast` (same primitives InstanceAccess already uses at lines 6–12).
- Produces:

  ```ts
  // ui/src/api/instanceSettings.ts
  getVisibility: () =>
    api.get<InstanceVisibilitySettings>("/instance/settings/visibility"),
  updateVisibility: (patch: PatchInstanceVisibilitySettings) =>
    api.patch<InstanceVisibilitySettings>("/instance/settings/visibility", patch),
  ```

  and `export function CompanySurfaceVisibilityCard(): JSX.Element`.

**Steps:**

- [ ] Write the failing test — create `ui/src/components/access/CompanySurfaceVisibilityCard.test.tsx` (complete file). If the `Checkbox` primitive does not render `role="checkbox"` in jsdom (check `ui/src/components/ui/checkbox.tsx` — Radix checkboxes render `<button role="checkbox">`), adjust the selector to whatever that file renders, keeping the count/click assertions:

  ```tsx
  // @vitest-environment jsdom

  import { createRoot } from "react-dom/client";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

  const mockInstanceSettingsApi = vi.hoisted(() => ({
    getVisibility: vi.fn(),
    updateVisibility: vi.fn(),
  }));
  const pushToastMock = vi.hoisted(() => vi.fn());

  vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
  vi.mock("@/context/ToastContext", () => ({
    useToast: () => ({ pushToast: pushToastMock }),
  }));

  import { CompanySurfaceVisibilityCard } from "./CompanySurfaceVisibilityCard";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  async function act(callback: () => void | Promise<void>) {
    await callback();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  async function flushReact() {
    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }

  describe("CompanySurfaceVisibilityCard", () => {
    let container: HTMLDivElement;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
    });

    afterEach(() => {
      container.remove();
      document.body.innerHTML = "";
      vi.clearAllMocks();
    });

    async function renderCard() {
      const root = createRoot(container);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <CompanySurfaceVisibilityCard />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      return root;
    }

    it("renders a checkbox per company surface reflecting the policy", async () => {
      mockInstanceSettingsApi.getVisibility.mockResolvedValue({
        companySurfaces: ["company.general", "company.members"],
      });
      const root = await renderCard();

      expect(container.textContent).toContain("Company settings visibility");
      const checkboxes = container.querySelectorAll('[role="checkbox"]');
      expect(checkboxes.length).toBe(5);
      expect(checkboxes[0]?.getAttribute("aria-checked")).toBe("true"); // General
      expect(checkboxes[1]?.getAttribute("aria-checked")).toBe("true"); // Members
      expect(checkboxes[2]?.getAttribute("aria-checked")).toBe("false"); // Invites

      await act(async () => root.unmount());
    });

    it("saves the selected surfaces via PATCH and refreshes capabilities", async () => {
      mockInstanceSettingsApi.getVisibility.mockResolvedValue({
        companySurfaces: [
          "company.general",
          "company.members",
          "company.invites",
          "company.secrets",
          "company.plugins",
        ],
      });
      mockInstanceSettingsApi.updateVisibility.mockResolvedValue({
        companySurfaces: ["company.general"],
      });
      const root = await renderCard();

      const checkboxes = Array.from(container.querySelectorAll('[role="checkbox"]'));
      for (const checkbox of checkboxes.slice(1)) {
        await act(async () => {
          checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
      }
      const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Save visibility"),
      );
      expect(saveButton).toBeDefined();
      await act(async () => {
        saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();

      expect(mockInstanceSettingsApi.updateVisibility).toHaveBeenCalledWith({
        companySurfaces: ["company.general"],
      });
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Company settings visibility updated" }),
      );

      await act(async () => root.unmount());
    });
  });
  ```
- [ ] Run: `cd ui && pnpm vitest run src/components/access/CompanySurfaceVisibilityCard.test.tsx` — expected failure: module not found.
- [ ] Append to `ui/src/api/instanceSettings.ts` (inside `instanceSettingsApi`, after `updateExperimental` at line 24; extend the type import at lines 1–9 with `InstanceVisibilitySettings, PatchInstanceVisibilitySettings`):

  ```ts
  getVisibility: () =>
    api.get<InstanceVisibilitySettings>("/instance/settings/visibility"),
  updateVisibility: (patch: PatchInstanceVisibilitySettings) =>
    api.patch<InstanceVisibilitySettings>("/instance/settings/visibility", patch),
  ```

- [ ] Create `ui/src/components/access/CompanySurfaceVisibilityCard.tsx`:

  ```tsx
  import { useEffect, useState } from "react";
  import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
  import { COMPANY_SETTINGS_SURFACES, type CompanySettingsSurface } from "@paperclipai/shared";
  import { instanceSettingsApi } from "@/api/instanceSettings";
  import { Button } from "@/components/ui/button";
  import { Card } from "@/components/ui/card";
  import { Checkbox } from "@/components/ui/checkbox";
  import { useToast } from "@/context/ToastContext";
  import { queryKeys } from "@/lib/queryKeys";

  const SURFACE_LABELS: Record<CompanySettingsSurface, { label: string; hint: string }> = {
    "company.general": { label: "General", hint: "Company name, branding, defaults" },
    "company.members": { label: "Members", hint: "Membership, roles, join requests" },
    "company.invites": { label: "Invites", hint: "Creating and revoking invites" },
    "company.secrets": { label: "Secrets", hint: "Company secrets and providers" },
    "company.plugins": {
      label: "Plugins",
      hint: "Plugin catalog page only — enabled plugins' own pages always render",
    },
  };

  export function CompanySurfaceVisibilityCard() {
    const { pushToast } = useToast();
    const queryClient = useQueryClient();
    const [selected, setSelected] = useState<Set<CompanySettingsSurface>>(new Set());

    const visibilityQuery = useQuery({
      queryKey: queryKeys.instance.visibilitySettings,
      queryFn: () => instanceSettingsApi.getVisibility(),
    });

    useEffect(() => {
      if (visibilityQuery.data) {
        setSelected(new Set(visibilityQuery.data.companySurfaces));
      }
    }, [visibilityQuery.data]);

    const saveMutation = useMutation({
      mutationFn: () =>
        instanceSettingsApi.updateVisibility({
          companySurfaces: COMPANY_SETTINGS_SURFACES.filter((surface) => selected.has(surface)),
        }),
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.instance.visibilitySettings });
        await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
        pushToast({ title: "Company settings visibility updated", tone: "success" });
      },
    });

    return (
      <Card className="block space-y-4 p-5">
        <div>
          <h2 className="text-sm font-semibold">Company settings visibility</h2>
          <p className="text-sm text-muted-foreground">
            Choose which company settings surfaces non-admin company members can use on this
            instance. Instance admins always see everything. Instance-scoped settings are never
            visible to non-admins.
          </p>
        </div>
        {visibilityQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading visibility policy…</div>
        ) : visibilityQuery.error ? (
          <div className="text-sm text-destructive">Failed to load the visibility policy.</div>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              {COMPANY_SETTINGS_SURFACES.map((surface) => (
                <label
                  key={surface}
                  className="flex items-start gap-3 rounded-lg border border-border px-3 py-3"
                >
                  <Checkbox
                    checked={selected.has(surface)}
                    onCheckedChange={(checked) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(surface);
                        else next.delete(surface);
                        return next;
                      });
                    }}
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">{SURFACE_LABELS[surface].label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {SURFACE_LABELS[surface].hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex justify-end">
              <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving…" : "Save visibility"}
              </Button>
            </div>
          </>
        )}
      </Card>
    );
  }
  ```

- [ ] Mount in `ui/src/pages/InstanceAccess.tsx`: add `import { CompanySurfaceVisibilityCard } from "@/components/access/CompanySurfaceVisibilityCard";` and insert `<CompanySurfaceVisibilityCard />` after the closing `</div>` of the `grid gap-6 lg:grid-cols-(--gtc-34)` block (line 248), still inside the outer `max-w-6xl space-y-6` container.
- [ ] Run: `cd ui && pnpm vitest run src/components/access/CompanySurfaceVisibilityCard.test.tsx src/lib/features-migration-guard.test.ts` — expected: pass (the card file is allowlisted in the guard).
- [ ] Run: `cd ui && pnpm tsc --noEmit`.
- [ ] Commit:

  ```
  git add ui/src/api/instanceSettings.ts ui/src/components/access/CompanySurfaceVisibilityCard.tsx ui/src/components/access/CompanySurfaceVisibilityCard.test.tsx ui/src/pages/InstanceAccess.tsx
  git commit -m "feat(ui): company settings visibility card on Instance Access

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

## Task 15: Final verification sweep

**Files:** none created (fix-forward only).

**Steps:**

- [ ] Full typecheck: `pnpm -r --filter '!./plugins/**' typecheck` (or per package: `cd packages/shared && pnpm typecheck`, `cd packages/db && pnpm typecheck`, `cd server && pnpm tsc --noEmit`, `cd ui && pnpm tsc --noEmit`) — expected: clean.
- [ ] Server suites touched by this PR: `cd server && pnpm vitest run src/__tests__/instance-settings-service.test.ts src/__tests__/instance-settings-visibility-service.test.ts src/__tests__/instance-settings-routes.test.ts src/__tests__/authz-surface-exposure.test.ts src/__tests__/cli-auth-me-capabilities.test.ts src/__tests__/settings-surface-gating-routes.test.ts src/__tests__/access-routes-permissions-upgrade.test.ts` — expected: all pass.
- [ ] Shared suite: `cd packages/shared && pnpm vitest run` — expected: all pass.
- [ ] Full UI suite: `cd ui && pnpm vitest run` — expected: green apart from pre-existing known flakes unrelated to settings (compare failures against `git stash`-free main if in doubt; any failure in a file this plan touched must be fixed).
- [ ] Behavioral spot-checks against the spec:
  - §3.2 default: fresh DB → `GET /cli-auth/me` exposes ALL company surfaces (covered by cli-auth-me test 1).
  - §3.3 read hole closed: non-admin `GET /instance/settings/experimental` → 403 (instance-settings-routes test).
  - §3.4 typed 403: hidden surface → `{ code: "surface_not_exposed" }` (gating routes test).
  - §3.4 local_trusted: implicit actor bypasses gates and sees full nav (gating routes test + cli-auth-me test + sidebar admin test).
  - §6: SurfaceGuard redirect + degrade-closed sidebar tests.
- [ ] Grep for leftovers: `grep -rn "assertBoardOrgAccess" server/src/routes/instance-settings.ts` → no matches; `grep -rn "instanceSettingsApi.getExperimental" ui/src --include="*.tsx" --include="*.ts" | grep -v test | grep -v InstanceExperimentalSettings | grep -v "api/instanceSettings"` → no matches.
- [ ] Do NOT push, do NOT open a PR, do NOT commit `pnpm-lock.yaml`. Leave the branch with the task commits for review.

---

## Spec §3/§6/§7 coverage matrix

| Spec requirement | Task(s) |
|---|---|
| §3.1 surface taxonomy constants | 1 |
| §3.2 `visibility` section, type + Zod validator, default = all | 2, 3, 4 |
| §3.2 `GET/PATCH /instance/settings/visibility` (PATCH admin-gated) | 6 |
| §3.2 admin card on Instance Access | 14 |
| §3.3 capabilities payload on `GET /cli-auth/me` | 5, 9 |
| §3.3 `features` allowlist + UI stops reading `/instance/settings/experimental` | 5, 11, 12 |
| §3.3 reads flip to `assertCanManageInstanceSettings` (same-PR UI migration) | 7 (+11, 12) |
| §3.4 `assertSurfaceExposed` in authz.ts, applied to members/invites/secrets groups | 8, 10 |
| §3.4 admin + `local_trusted` bypass; 403 `surface_not_exposed` | 8, 10 |
| §3.4 UI renders from `capabilities.exposedSurfaces`; instance section admin-only | 13 |
| §6 typed 403 treated as navigation miss (redirect to settings root), not a crash | 13 (SurfaceGuard; pages keep their error states for raw 403s) |
| §6 capabilities failures degrade closed for nav, never block loaded pages | 13 (sidebar degrade test, SurfaceGuard fallthrough) |
| §7 taxonomy/validator unit tests | 1, 2 |
| §7 route authz tests: instance-settings reads 403 for non-admins | 7 |
| §7 `assertSurfaceExposed` per surface × role matrix | 8 (unit matrix), 10 (route matrix incl. viewer + partial policy) |
| §7 UI sidebar/nav-from-capabilities tests (admin vs owner vs member) | 13 |
| §7 regression: `local_trusted` sees everything | 7, 9, 10, 13 |
| §7 migration test for UI switch to `capabilities.features` | 11 (hook), 12 (repo-wide guard test) |

## Deviations from the pinned cross-plan contract (grounded in actual code)

1. **`PublicFeatureFlags` includes five general/instance-derived fields** (`keyboardShortcuts`, `censorUsernameInLogs`, `feedbackDataSharingPreference`, `executionMode`, `defaultEnvironmentId`) beyond the pinned "experimental subset". Reason: the pinned behavior change also closes `GET /instance/settings` and `GET /instance/settings/general` to admins in the same PR, and the non-admin UI reads these exact fields today (Layout.tsx:188-191, useLiveRunTranscripts.ts:150-153/459, AgentDetail.tsx:3864-3867, IssueDetail.tsx:1757-1772, AgentConfigForm.tsx:245-271/443, Agents.tsx:201-207, CompanyEnvironments.tsx:1174-1178/1555, Pipelines.tsx:2113-2118). Without them, the same-PR UI migration is impossible. All experimental flags actually read by the UI (18) are enumerated; `managedExperience` from the spec's illustrative list does not exist in the codebase and is omitted.
2. **`assertSurfaceExposed(req, surface, getExposedSurfaces)`** — the pinned name and file are kept; a third resolver parameter is added because `server/src/routes/authz.ts` is deliberately DB-free (every existing helper reads only `req.actor`), and admin/local bypass must not incur a DB read.
3. **Agent actors bypass the surface gate.** The gated secrets route group is also agent-facing (`assertCompanyAccess` admits agent keys); the policy per spec targets human settings surfaces, and blocking agents would break runtime secret access. Covered by an explicit unit test.
4. **`/cli-auth/me` `isInstanceAdmin` now ORs the actor claim** (`source === "local_implicit"` / `req.actor.isInstanceAdmin`). Today the field only reflects DB role rows (access.ts:2857-2861) and is `false` for the synthetic local-board user (auth.ts:144-154) — nav gating from this payload would otherwise hide the instance section in `local_trusted` mode, violating the spec's regression requirement.
5. **`GET /instance/settings/visibility` is admin-only** (spec only pins the PATCH gate). Non-admins receive exposed surfaces via capabilities; leaving the raw policy readable would partially reopen the read hole §3.3 closes.
6. **DB migration is required** (new `visibility` jsonb column): the table stores each section in its own jsonb column, so "new section beside general/experimental" = new column. Hand-written SQL 0173 + journal entry, no drizzle snapshot (fork's snapshot chain is broken; 0168–0172 precedent).
7. **`company.general` and `company.plugins` are nav-gated only in PR-1.** Spec §3.4's server enforcement list names members/invites management, secrets, and the plugin catalog; the catalog route ships in PR-2 (its gate belongs there), and company-general PATCH routes are shared with non-settings flows, so PR-1 adds no server gate for them.
8. **`GET /companies/:companyId/user-directory` and `/companies/:companyId/me/user-secrets*` are not gated** despite living near gated groups: the user directory feeds mentions/pickers app-wide, and per-user secret values are prompted from run flows; gating them would break non-settings features. Both choices are pinned by tests.
