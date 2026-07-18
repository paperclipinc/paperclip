# PR-2: Per-Company Plugin Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the dormant `plugin_company_settings.enabled` switch so companies decide per-company which installed plugins act for them. Adds the `companyEnablement` manifest field (`default: "on" | "off"`, `locked`), the `plugins:manage` permission key (implicit for company owner/admin), a company plugin catalog + enablement toggle API, enforcement at all 6 plugin execution gates, and a company-settings "Plugins" UI page. Implements spec §4 of `docs/superpowers/specs/2026-07-18-settings-visibility-and-plugin-enablement-design.md`, plus its §6 error-handling and §7 testing rows.

**Architecture:** Two AND-ed switches: instance switch (`plugins.status === "ready"`, exists) and company switch (`plugin_company_settings.enabled`, exists in schema but unenforced). A single new helper service (`server/src/services/plugin-company-enablement.ts`) computes the effective company switch from the manifest default plus the settings row, and every enforcement point delegates to it. Routes live in the existing `server/src/routes/plugins.ts` router. UI reads a catalog endpoint and toggles via a PUT; UI slot contributions are filtered server-side per company and the react-query key is company-scoped.

**Tech Stack:** TypeScript strict, Express 5-style async route handlers, Drizzle ORM (Postgres), Zod (shared validators), vitest (root config with per-package projects), React + @tanstack/react-query + jsdom component tests, pnpm workspace.

## Global Constraints

- **Worktree:** Work ONLY in `/Users/jannesstubbemann/repos/paperclip/wt-specs-billing-visibility`. All paths below are relative to that root unless written absolute.
- **Cross-plan dependency (PR-1):** Task 6 consumes `assertSurfaceExposed` from `server/src/routes/authz.ts`. That helper is delivered by the **PR-1 plan** (settings-surface policy) — it does **not** exist on this branch today (verified: `server/src/routes/authz.ts` has no such export). PR-2's branch must therefore be **stacked on PR-1's branch** (slice order PR-1 → PR-2 per spec §8). All PR-2 route tests mock `assertSurfaceExposed`, so tests do not depend on PR-1's internals — only the export must exist for typecheck. PR-1's landed signature (reconciled 2026-07-18) is `assertSurfaceExposed(req, surface, getExposedSurfaces)` — authz.ts stays DB-free, so callers inject an async resolver. Task 6 sets up the same resolver pattern PR-1 uses in its own route factories: `const instanceSettingsSvc = instanceSettingsService(db); const getExposedCompanySurfaces = async () => (await instanceSettingsSvc.getVisibility()).companySurfaces;`. Only Task 6 touches this.
- **Prior art:** A sibling worktree `/Users/jannesstubbemann/repos/paperclip/wt-upstream-plugin-enablement` (branch `contrib/company-plugin-enablement`) implements a close cousin. Steps below say "adapt from contrib/company-plugin-enablement:<file>" where applicable AND include the full target code inline — you do **not** need that worktree to execute this plan. **NEVER modify that worktree.** Designed deltas vs that branch (all included below): manifest `companyEnablement.default`/`locked`, the `plugins:manage` permission key, and the PR-1 surface gate on the catalog route.
- **No DB migration:** `plugin_company_settings` already exists (`packages/db/src/schema/plugin_company_settings.ts`, with `enabled boolean NOT NULL DEFAULT true` and a `(company_id, plugin_id)` unique index). Verified. Do not generate migrations (the fork's drizzle snapshot chain is forked; `drizzle-kit generate` fails).
- **No new dependencies.** Never commit `pnpm-lock.yaml`.
- **Run tests from the repo root** with `pnpm exec vitest run <path>` (the root `vitest.config.ts` declares `packages/shared`, `server`, and `ui` as projects, so file paths resolve to the right project). TypeScript check: `pnpm --filter @paperclipai/shared typecheck`, `pnpm --filter server typecheck`, `pnpm --filter ui typecheck` where needed (if a `typecheck` script is missing in a package, use `pnpm exec tsc --noEmit -p <pkg>`).
- **Commits:** conventional commits, one per task, ending with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Exact commands are given per task.
- **Known suite flake (do not chase):** `heartbeat-process-recovery` has one test that always fails on macOS. It is unrelated to this work.
- **Pinned semantics (source of truth for every task):**
  - Manifest `companyEnablement` absent ⇒ default `"on"` (today's behavior).
  - `default: "on"`, no `plugin_company_settings` row ⇒ enabled. `default: "off"`, no row ⇒ disabled.
  - A row always wins over the manifest default (`row.enabled` is the answer).
  - `locked: true` ⇒ companies cannot toggle (409 `plugin_enablement_locked` for non-instance-admins); the effective state is the manifest default unless an instance admin has written a row. There is no author column on the row — lock enforcement happens at **write time** (only instance admins get past the 409), so any existing row on a locked plugin was necessarily instance-admin-written and the read path simply honors it.
  - Enforcement failure is the typed 403 `plugin_not_enabled_for_company` (serialized by `server/src/middleware/error-handler.ts` as `{ error, code }` when `details.code` is a string).
  - Event-bus delivery **fails open** on enablement-lookup errors (an error must never silently drop events); every request-path gate **fails closed**.
  - Sandbox-provider/credential-broker infrastructure plugins are excluded from the catalog. NOTE: this codebase has **no** `sandbox-provider`/`credential-broker` manifest *categories* (`PLUGIN_CATEGORIES` is `["connector","workspace","automation","ui"]`); infrastructure plugins are identified by `manifest.environmentDrivers[].kind === "sandbox_provider"` — the same predicate already used by `isSandboxProviderOnly()` in `ui/src/components/CompanySettingsSidebar.tsx:38`. The catalog uses that predicate.

---

## Task 1: Shared manifest contract — `companyEnablement`

**Files:**
- Modify: `packages/shared/src/types/plugin.ts` (insert after the `capabilities` field of `PaperclipPluginManifestV1`, currently lines 594–595)
- Modify: `packages/shared/src/validators/plugin.ts` (insert into `pluginManifestV1Schema`, after the `capabilities` key, currently line 726)
- Test: `packages/shared/src/validators/plugin.test.ts` (append a new `describe` block)

**Interfaces:**
- Produces (type addition on `PaperclipPluginManifestV1`):
  ```ts
  companyEnablement?: { default: "on" | "off"; locked?: boolean };
  ```
- Produces (Zod, inside `pluginManifestV1Schema`):
  ```ts
  companyEnablement: z.object({ default: z.enum(["on", "off"]), locked: z.boolean().optional() }).optional(),
  ```
- Consumes: nothing new. `server/src/services/plugin-manifest-validator.ts` needs **no change** — verified it delegates entirely to `pluginManifestV1Schema.safeParse` (it contains no field-level logic), so the shared Zod update flows through automatically.

**Steps:**

- [ ] **1.1 Write the failing test.** Append this block to the end of `packages/shared/src/validators/plugin.test.ts`:

  ```ts
  describe("plugin manifest companyEnablement", () => {
    const baseManifest = {
      id: "paperclip.company-enablement-fixture",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Company Enablement Fixture",
      description: "Manifest fixture for companyEnablement validation.",
      author: "Paperclip",
      categories: ["ui"],
      capabilities: ["ui.dashboardWidget.register"],
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui.js",
      },
      ui: {
        slots: [
          {
            type: "dashboardWidget",
            id: "fixture-widget",
            displayName: "Fixture Widget",
            exportName: "FixtureWidget",
          },
        ],
      },
    };

    it("accepts a manifest without companyEnablement (default on)", () => {
      const parsed = pluginManifestV1Schema.parse(baseManifest);
      expect(parsed.companyEnablement).toBeUndefined();
    });

    it("accepts default on and default off", () => {
      expect(
        pluginManifestV1Schema.parse({
          ...baseManifest,
          companyEnablement: { default: "on" },
        }).companyEnablement,
      ).toEqual({ default: "on" });
      expect(
        pluginManifestV1Schema.parse({
          ...baseManifest,
          companyEnablement: { default: "off" },
        }).companyEnablement,
      ).toEqual({ default: "off" });
    });

    it("accepts locked with a default", () => {
      const parsed = pluginManifestV1Schema.parse({
        ...baseManifest,
        companyEnablement: { default: "off", locked: true },
      });
      expect(parsed.companyEnablement).toEqual({ default: "off", locked: true });
    });

    it("rejects an invalid default value", () => {
      const result = pluginManifestV1Schema.safeParse({
        ...baseManifest,
        companyEnablement: { default: "maybe" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects companyEnablement without a default", () => {
      const result = pluginManifestV1Schema.safeParse({
        ...baseManifest,
        companyEnablement: { locked: true },
      });
      expect(result.success).toBe(false);
    });
  });
  ```

  (The base fixture mirrors the file's existing "accepts existing-style plugins" fixture, which is known-valid against the current schema.)

- [ ] **1.2 Run it — expect failure.**
  ```bash
  pnpm exec vitest run packages/shared/src/validators/plugin.test.ts
  ```
  Expected: the two `accepts` tests fail. NOTE the failure mode: Zod's `.parse` on `z.object` **strips unknown keys** rather than erroring, so the failures are `parsed.companyEnablement` being `undefined` in "accepts default on and default off" and "accepts locked with a default", and `result.success` being `true` (not false) in the two `rejects` tests. All four must fail before implementing; "accepts a manifest without companyEnablement" passes already (that's fine — it pins backward compatibility).

- [ ] **1.3 Implement the type.** In `packages/shared/src/types/plugin.ts`, find (currently lines 594–595):

  ```ts
    /** Capabilities this plugin requires from the host. Enforced at runtime. */
    capabilities: PluginCapability[];
  ```

  and insert immediately after:

  ```ts
    /**
     * Per-company enablement defaults for this plugin.
     *
     * - Absent ⇒ `default: "on"` (today's behavior; existing plugins unaffected).
     * - `default: "off"` makes the plugin opt-in per company: no
     *   `plugin_company_settings` row ⇒ disabled for that company.
     * - `locked: true` ⇒ companies cannot toggle the plugin themselves; the
     *   effective state is the manifest default unless an instance admin has
     *   written a per-company override row (governance plugins, e.g. billing).
     *
     * A `plugin_company_settings` row always overrides the manifest default.
     */
    companyEnablement?: {
      default: "on" | "off";
      locked?: boolean;
    };
  ```

- [ ] **1.4 Implement the Zod schema.** In `packages/shared/src/validators/plugin.ts`, find (currently line 726):

  ```ts
    capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).min(1),
  ```

  and insert immediately after:

  ```ts
    companyEnablement: z.object({
      default: z.enum(["on", "off"]),
      locked: z.boolean().optional(),
    }).optional(),
  ```

- [ ] **1.5 Run the test — expect pass.**
  ```bash
  pnpm exec vitest run packages/shared/src/validators/plugin.test.ts
  ```
  Expected: all tests in the file pass (pre-existing blocks included).

- [ ] **1.6 Typecheck shared + server** (server consumes the type):
  ```bash
  pnpm --filter @paperclipai/shared typecheck && pnpm --filter server typecheck
  ```

- [ ] **1.7 Commit.**
  ```bash
  git add packages/shared/src/types/plugin.ts packages/shared/src/validators/plugin.ts packages/shared/src/validators/plugin.test.ts
  git commit -m "$(cat <<'EOF'
  feat(shared): add companyEnablement manifest field (default on/off, locked)

  Per-company plugin enablement (spec 2026-07-18 §4.2): plugins may declare
  an opt-in default and a locked flag for instance-managed governance
  plugins. Absent field keeps today's default-on behavior.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 2: `plugins:manage` permission key, implicit for owner/admin

**Files:**
- Modify: `packages/shared/src/constants.ts` (`PERMISSION_KEYS`, currently lines 908–928)
- Modify: `server/src/services/company-member-roles.ts` (`grantsForHumanRole`, lines 27–48)
- Test (create): `server/src/services/company-member-roles.test.ts`

**Interfaces:**
- Produces: `"plugins:manage"` as a member of `PERMISSION_KEYS` (and therefore of the `PermissionKey` union).
- Produces: `grantsForHumanRole("owner")` and `grantsForHumanRole("admin")` include `{ permissionKey: "plugins:manage", scope: null }`.
- How "implicit role permissions" actually work in this codebase (read before assuming an `authorization.ts` code path): board-user permission checks flow `access.canUser(...)` → `authorizationService.decide(...)` → `decidePrincipalGrant(...)`, which reads **`principal_permission_grants` rows**. Roles get their implicit permissions because default grant rows are *seeded* from `grantsForHumanRole(role)` via `ensureHumanRoleDefaultGrants` (`server/src/services/principal-access-compatibility.ts:57`) — called on membership creation/claim (`server/src/middleware/auth.ts:462`, `server/src/board-claim.ts:147`, `server/src/services/access.ts:612/628`) and re-run for **all existing active memberships** at server startup by `backfillPrincipalAccessCompatibility` (`server/src/index.ts:536`), which uses `onConflictDoNothing` and therefore idempotently adds newly introduced keys to existing owner/admin members. So adding the key to `grantsForHumanRole` **is** the wiring; `authorization.ts` itself needs no change (its `permissionForAction` maps any unlisted `PermissionKey` action to itself, and instance admins short-circuit to allow at `authorization.ts:1478`). `plugins:manage` remains grantable to any principal via the existing `principal_permission_grants` editing UI/API since those are keyed by `PermissionKey`.

**Steps:**

- [ ] **2.1 Write the failing test.** Create `server/src/services/company-member-roles.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";
  import { PERMISSION_KEYS } from "@paperclipai/shared";
  import type { HumanCompanyMembershipRole } from "@paperclipai/shared";
  import { grantsForHumanRole } from "./company-member-roles.js";

  function keysFor(role: HumanCompanyMembershipRole): string[] {
    return grantsForHumanRole(role).map((grant) => grant.permissionKey);
  }

  describe("plugins:manage permission key", () => {
    it("is a registered permission key", () => {
      expect(PERMISSION_KEYS).toContain("plugins:manage");
    });

    it("is implicitly granted to owner and admin roles", () => {
      expect(keysFor("owner")).toContain("plugins:manage");
      expect(keysFor("admin")).toContain("plugins:manage");
    });

    it("is not implicitly granted to operator or viewer roles", () => {
      expect(keysFor("operator")).not.toContain("plugins:manage");
      expect(keysFor("viewer")).not.toContain("plugins:manage");
    });
  });
  ```

- [ ] **2.2 Run it — expect failure.**
  ```bash
  pnpm exec vitest run server/src/services/company-member-roles.test.ts
  ```
  Expected: "is a registered permission key" and "is implicitly granted to owner and admin roles" fail; the operator/viewer test passes.

- [ ] **2.3 Implement.** In `packages/shared/src/constants.ts`, inside `PERMISSION_KEYS` (line 908), after `"joins:approve",` (line 927) add:

  ```ts
    "plugins:manage",
  ```

  In `server/src/services/company-member-roles.ts`, in `grantsForHumanRole`:
  - `case "owner":` — after `{ permissionKey: "joins:approve", scope: null },` add:
    ```ts
          { permissionKey: "plugins:manage", scope: null },
    ```
  - `case "admin":` — after `{ permissionKey: "joins:approve", scope: null },` add:
    ```ts
          { permissionKey: "plugins:manage", scope: null },
    ```

- [ ] **2.4 Run — expect pass.**
  ```bash
  pnpm exec vitest run server/src/services/company-member-roles.test.ts
  ```

- [ ] **2.5 Regression-run the permission seeding/grant suites** (they exercise `grantsForHumanRole` fixtures and must still pass with the extra key):
  ```bash
  pnpm exec vitest run server/src/__tests__/invite-join-grants.test.ts server/src/__tests__/access-service.test.ts server/src/__tests__/access-validators.test.ts
  ```
  Expected: pass. If a test asserts an **exact** grant list for owner/admin, update that fixture to include `plugins:manage` (that is the intended behavior change).

- [ ] **2.6 Commit.**
  ```bash
  git add packages/shared/src/constants.ts server/src/services/company-member-roles.ts server/src/services/company-member-roles.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): add plugins:manage permission key, implicit for owner/admin

  Seeded through the existing role default-grant path
  (grantsForHumanRole -> ensureHumanRoleDefaultGrants); startup backfill
  adds it to existing owner/admin memberships. Grantable to any principal
  via principal_permission_grants.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 3: Enablement helper service

Adapt from `contrib/company-plugin-enablement:server/src/services/plugin-company-enablement.ts` — but note the designed deltas: that branch's helper only looked at the settings row; this version consults the **manifest default** and emits the **typed** 403 code.

**Files:**
- Create: `server/src/services/plugin-company-enablement.ts`
- Modify (doc comment only, no schema change): `packages/db/src/schema/plugin_company_settings.ts` (lines 13–16)
- Test (create): `server/src/services/plugin-company-enablement.test.ts`

**Interfaces:**
- Produces (complete public surface of the new module):
  ```ts
  export type CompanyEnablementManifest =
    Pick<PaperclipPluginManifestV1, "companyEnablement"> | null | undefined;

  export function evaluateCompanyEnablement(
    manifest: CompanyEnablementManifest,
    settings: Pick<PluginCompanySettings, "enabled"> | null | undefined,
  ): boolean;

  export function assertCompanyEnablement(
    manifest: CompanyEnablementManifest,
    settings: Pick<PluginCompanySettings, "enabled"> | null | undefined,
  ): void; // throws typed 403 plugin_not_enabled_for_company

  export interface PluginEnablementRegistry {
    getById(pluginId: string): Promise<{ manifestJson: PaperclipPluginManifestV1 | null } | null>;
    getByKey(pluginKey: string): Promise<{ id: string; manifestJson: PaperclipPluginManifestV1 | null } | null>;
    getCompanySettings(pluginId: string, companyId: string): Promise<PluginCompanySettings | null>;
  }

  export function pluginCompanyEnablementService(registry: PluginEnablementRegistry): {
    isPluginEnabledForCompany(pluginId: string, companyId: string): Promise<boolean>;
    ensurePluginEnabledForCompany(pluginId: string, companyId: string): Promise<void>;
  };

  export function createPluginEventDeliverabilityChecker(
    registry: PluginEnablementRegistry,
    log: (context: { err: unknown; pluginKey: string; companyId: string }, msg: string) => void,
  ): (pluginKey: string, companyId: string) => Promise<boolean>;
  ```
  The pinned contract method `isPluginEnabledForCompany(pluginId: string, companyId: string): Promise<boolean>` is exposed with exactly that signature as a method of `pluginCompanyEnablementService(registry)`. It is not a bare module-level function because this codebase has **no** module-global db handle (every service is a `(db) => api` / `(registry) => api` factory — see `pluginRegistryService`, `accessService`, `logActivity(db, …)`); the registry dependency must be injected. This mirrors the prior-art branch, which passed `registry` as a leading parameter.
- Consumes: `pluginRegistryService(db).getById / getByKey / getCompanySettings` (`server/src/services/plugin-registry.ts:68/76/397` — a wider registry object structurally satisfies `PluginEnablementRegistry`); `forbidden` from `server/src/errors.js`; types from `@paperclipai/shared`.

**Steps:**

- [ ] **3.1 Write the failing test.** Create `server/src/services/plugin-company-enablement.test.ts`:

  ```ts
  import { describe, expect, it, vi } from "vitest";
  import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
  import {
    assertCompanyEnablement,
    createPluginEventDeliverabilityChecker,
    evaluateCompanyEnablement,
    pluginCompanyEnablementService,
    type PluginEnablementRegistry,
  } from "./plugin-company-enablement.js";

  const pluginUuid = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";

  function manifestWith(
    companyEnablement?: { default: "on" | "off"; locked?: boolean },
  ): Pick<PaperclipPluginManifestV1, "companyEnablement"> {
    return companyEnablement ? { companyEnablement } : {};
  }

  describe("evaluateCompanyEnablement", () => {
    it("defaults to enabled when the manifest has no companyEnablement and no row exists", () => {
      expect(evaluateCompanyEnablement(undefined, null)).toBe(true);
      expect(evaluateCompanyEnablement(null, undefined)).toBe(true);
      expect(evaluateCompanyEnablement(manifestWith(), null)).toBe(true);
    });

    it("honors an explicit row over any manifest default", () => {
      expect(evaluateCompanyEnablement(manifestWith(), { enabled: false })).toBe(false);
      expect(evaluateCompanyEnablement(manifestWith(), { enabled: true })).toBe(true);
      expect(
        evaluateCompanyEnablement(manifestWith({ default: "off" }), { enabled: true }),
      ).toBe(true);
      expect(
        evaluateCompanyEnablement(manifestWith({ default: "on" }), { enabled: false }),
      ).toBe(false);
    });

    it("uses the manifest default when no row exists", () => {
      expect(evaluateCompanyEnablement(manifestWith({ default: "on" }), null)).toBe(true);
      expect(evaluateCompanyEnablement(manifestWith({ default: "off" }), null)).toBe(false);
    });

    it("treats locked as read-transparent: manifest default unless a row overrides", () => {
      // Lock enforcement is write-time (the toggle route 409s non-admins);
      // an existing row on a locked plugin is instance-admin-written by
      // construction, so the read path honors it.
      expect(
        evaluateCompanyEnablement(manifestWith({ default: "off", locked: true }), null),
      ).toBe(false);
      expect(
        evaluateCompanyEnablement(manifestWith({ default: "off", locked: true }), { enabled: true }),
      ).toBe(true);
      expect(
        evaluateCompanyEnablement(manifestWith({ default: "on", locked: true }), null),
      ).toBe(true);
    });
  });

  describe("assertCompanyEnablement", () => {
    it("throws the typed 403 when the effective state is disabled", () => {
      let caught: unknown;
      try {
        assertCompanyEnablement(manifestWith({ default: "off" }), null);
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({
        status: 403,
        details: { code: "plugin_not_enabled_for_company" },
      });
    });

    it("does not throw when the effective state is enabled", () => {
      expect(() => assertCompanyEnablement(undefined, null)).not.toThrow();
    });
  });

  function fakeRegistry(overrides: Partial<PluginEnablementRegistry> = {}): PluginEnablementRegistry {
    return {
      getById: vi.fn(async () => ({ manifestJson: {} as PaperclipPluginManifestV1 })),
      getByKey: vi.fn(async () => null),
      getCompanySettings: vi.fn(async () => null),
      ...overrides,
    };
  }

  describe("pluginCompanyEnablementService", () => {
    it("resolves the manifest via getById and combines it with the settings row", async () => {
      const registry = fakeRegistry({
        getById: vi.fn(async () => ({
          manifestJson: { companyEnablement: { default: "off" } } as PaperclipPluginManifestV1,
        })),
        getCompanySettings: vi.fn(async () => null),
      });
      const service = pluginCompanyEnablementService(registry);

      await expect(service.isPluginEnabledForCompany(pluginUuid, companyId)).resolves.toBe(false);
      expect(registry.getById).toHaveBeenCalledWith(pluginUuid);
      expect(registry.getCompanySettings).toHaveBeenCalledWith(pluginUuid, companyId);
    });

    it("returns true for a default-on plugin without a row and false with a disabled row", async () => {
      const service = pluginCompanyEnablementService(fakeRegistry());
      await expect(service.isPluginEnabledForCompany(pluginUuid, companyId)).resolves.toBe(true);

      const disabled = pluginCompanyEnablementService(fakeRegistry({
        getCompanySettings: vi.fn(async () => ({ enabled: false }) as never),
      }));
      await expect(disabled.isPluginEnabledForCompany(pluginUuid, companyId)).resolves.toBe(false);
    });

    it("treats an unknown pluginId as disabled (fail closed)", async () => {
      const service = pluginCompanyEnablementService(fakeRegistry({
        getById: vi.fn(async () => null),
      }));
      await expect(service.isPluginEnabledForCompany(pluginUuid, companyId)).resolves.toBe(false);
    });

    it("ensurePluginEnabledForCompany throws the typed 403 when disabled", async () => {
      const service = pluginCompanyEnablementService(fakeRegistry({
        getCompanySettings: vi.fn(async () => ({ enabled: false }) as never),
      }));
      await expect(
        service.ensurePluginEnabledForCompany(pluginUuid, companyId),
      ).rejects.toMatchObject({
        status: 403,
        details: { code: "plugin_not_enabled_for_company" },
      });
    });

    it("ensurePluginEnabledForCompany resolves when enabled", async () => {
      const service = pluginCompanyEnablementService(fakeRegistry());
      await expect(
        service.ensurePluginEnabledForCompany(pluginUuid, companyId),
      ).resolves.toBeUndefined();
    });
  });

  describe("createPluginEventDeliverabilityChecker", () => {
    const pluginKey = "acme.linear";

    it("resolves the plugin key via getByKey and evaluates manifest + row", async () => {
      const getByKey = vi.fn(async () => ({
        id: pluginUuid,
        manifestJson: {} as PaperclipPluginManifestV1,
      }));
      const getCompanySettings = vi.fn(async () => ({ enabled: true }) as never);
      const log = vi.fn();
      const checker = createPluginEventDeliverabilityChecker(
        fakeRegistry({ getByKey, getCompanySettings }),
        log,
      );

      await expect(checker(pluginKey, companyId)).resolves.toBe(true);
      expect(getByKey).toHaveBeenCalledWith(pluginKey);
      expect(getCompanySettings).toHaveBeenCalledWith(pluginUuid, companyId);
      expect(log).not.toHaveBeenCalled();
    });

    it("returns false when the row disables the plugin", async () => {
      const checker = createPluginEventDeliverabilityChecker(
        fakeRegistry({
          getByKey: vi.fn(async () => ({ id: pluginUuid, manifestJson: {} as PaperclipPluginManifestV1 })),
          getCompanySettings: vi.fn(async () => ({ enabled: false }) as never),
        }),
        vi.fn(),
      );
      await expect(checker(pluginKey, companyId)).resolves.toBe(false);
    });

    it("returns false for a default-off plugin with no row (manifest-aware)", async () => {
      const checker = createPluginEventDeliverabilityChecker(
        fakeRegistry({
          getByKey: vi.fn(async () => ({
            id: pluginUuid,
            manifestJson: { companyEnablement: { default: "off" } } as PaperclipPluginManifestV1,
          })),
          getCompanySettings: vi.fn(async () => null),
        }),
        vi.fn(),
      );
      await expect(checker(pluginKey, companyId)).resolves.toBe(false);
    });

    it("fails open and skips the settings lookup when the plugin key is unknown", async () => {
      const getCompanySettings = vi.fn();
      const checker = createPluginEventDeliverabilityChecker(
        fakeRegistry({ getByKey: vi.fn(async () => null), getCompanySettings }),
        vi.fn(),
      );
      await expect(checker(pluginKey, companyId)).resolves.toBe(true);
      expect(getCompanySettings).not.toHaveBeenCalled();
    });

    it("fails open and logs when the lookup throws", async () => {
      const err = new Error("db exploded");
      const log = vi.fn();
      const checker = createPluginEventDeliverabilityChecker(
        fakeRegistry({ getByKey: vi.fn(async () => { throw err; }) }),
        log,
      );
      await expect(checker(pluginKey, companyId)).resolves.toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ err, pluginKey, companyId }),
        expect.any(String),
      );
    });
  });
  ```

- [ ] **3.2 Run it — expect failure** (module does not exist):
  ```bash
  pnpm exec vitest run server/src/services/plugin-company-enablement.test.ts
  ```
  Expected: failure to resolve `./plugin-company-enablement.js`.

- [ ] **3.3 Implement.** Create `server/src/services/plugin-company-enablement.ts`:

  ```ts
  /**
   * Per-company plugin enablement.
   *
   * Two AND-ed switches make a plugin act for a company: the instance switch
   * (`plugins.status === "ready"`, enforced elsewhere) and the company switch
   * computed here from the plugin manifest's `companyEnablement` default plus
   * the `plugin_company_settings` row:
   *
   * - no row + no manifest field            => enabled (backward compatible)
   * - no row + `default: "on"`              => enabled
   * - no row + `default: "off"`             => disabled (opt-in plugins)
   * - row                                   => row.enabled wins
   *
   * `locked: true` never changes the read path: lock enforcement happens at
   * write time (the enablement toggle route rejects non-instance-admins with
   * 409 `plugin_enablement_locked`), so any existing row on a locked plugin
   * was written by an instance admin and is honored here.
   *
   * @see docs/superpowers/specs/2026-07-18-settings-visibility-and-plugin-enablement-design.md §4
   */
  import type { PaperclipPluginManifestV1, PluginCompanySettings } from "@paperclipai/shared";
  import { forbidden } from "../errors.js";

  /** Minimal manifest slice the enablement computation needs. */
  export type CompanyEnablementManifest =
    Pick<PaperclipPluginManifestV1, "companyEnablement"> | null | undefined;

  /**
   * Pure enablement computation: settings row wins; otherwise the manifest
   * default; otherwise "on".
   */
  export function evaluateCompanyEnablement(
    manifest: CompanyEnablementManifest,
    settings: Pick<PluginCompanySettings, "enabled"> | null | undefined,
  ): boolean {
    if (settings) return settings.enabled;
    return (manifest?.companyEnablement?.default ?? "on") === "on";
  }

  /**
   * Throwing form of {@link evaluateCompanyEnablement} for request-path gates
   * that already hold the plugin record and settings row. Fails closed with
   * the typed 403 used at every enforcement point.
   */
  export function assertCompanyEnablement(
    manifest: CompanyEnablementManifest,
    settings: Pick<PluginCompanySettings, "enabled"> | null | undefined,
  ): void {
    if (!evaluateCompanyEnablement(manifest, settings)) {
      throw forbidden("Plugin is not enabled for this company", {
        code: "plugin_not_enabled_for_company",
      });
    }
  }

  /**
   * Registry surface the enablement service needs. The full
   * `pluginRegistryService(db)` object structurally satisfies this.
   */
  export interface PluginEnablementRegistry {
    getById(pluginId: string): Promise<{ manifestJson: PaperclipPluginManifestV1 | null } | null>;
    getByKey(pluginKey: string): Promise<{ id: string; manifestJson: PaperclipPluginManifestV1 | null } | null>;
    getCompanySettings(pluginId: string, companyId: string): Promise<PluginCompanySettings | null>;
  }

  /**
   * Registry-backed enablement service. `pluginId` is the plugin's database
   * UUID (`plugins.id`), matching `plugin_company_settings.plugin_id`.
   */
  export function pluginCompanyEnablementService(registry: PluginEnablementRegistry) {
    async function isPluginEnabledForCompany(pluginId: string, companyId: string): Promise<boolean> {
      const [plugin, settings] = await Promise.all([
        registry.getById(pluginId),
        registry.getCompanySettings(pluginId, companyId),
      ]);
      // Unknown plugin: fail closed. Request-path gates should have 404'd
      // earlier; anything that reaches this with a bogus id gets a deny.
      if (!plugin) return false;
      return evaluateCompanyEnablement(plugin.manifestJson, settings);
    }

    async function ensurePluginEnabledForCompany(pluginId: string, companyId: string): Promise<void> {
      if (!(await isPluginEnabledForCompany(pluginId, companyId))) {
        throw forbidden("Plugin is not enabled for this company", {
          code: "plugin_not_enabled_for_company",
        });
      }
    }

    return { isPluginEnabledForCompany, ensurePluginEnabledForCompany };
  }

  /**
   * Event-bus deliverability checker. The bus registers subscriptions under
   * the manifest `pluginKey` (see plugin-event-bus.ts `forPlugin`), so this
   * resolves key -> plugin record before consulting the manifest default and
   * `plugin_company_settings` (keyed by the plugin's uuid).
   *
   * Fails OPEN — an enablement lookup error must never silently drop events —
   * and logs so failures stay visible. This is deliberately the opposite of
   * the request-path gates, which fail closed.
   */
  export function createPluginEventDeliverabilityChecker(
    registry: PluginEnablementRegistry,
    log: (context: { err: unknown; pluginKey: string; companyId: string }, msg: string) => void,
  ): (pluginKey: string, companyId: string) => Promise<boolean> {
    return async (pluginKey, companyId) => {
      try {
        const plugin = await registry.getByKey(pluginKey);
        if (!plugin) return true;
        const settings = await registry.getCompanySettings(plugin.id, companyId);
        return evaluateCompanyEnablement(plugin.manifestJson, settings);
      } catch (err) {
        log(
          { err, pluginKey, companyId },
          "Plugin enablement lookup failed; delivering event (fail open)",
        );
        return true;
      }
    };
  }
  ```

- [ ] **3.4 Update the now-stale schema doc comment** (docs only — the column and its DB default are unchanged, so no migration). In `packages/db/src/schema/plugin_company_settings.ts` replace lines 13–16:

  ```ts
   * Rows represent explicit overrides from the default company behavior:
   * - no row => plugin is enabled for the company by default
   * - row with `enabled = false` => plugin is disabled for that company
   * - row with `enabled = true` => plugin remains enabled and stores company settings
  ```

  with:

  ```ts
   * Rows represent explicit overrides from the default company behavior:
   * - no row => the plugin manifest's `companyEnablement.default` applies
   *   ("on" when the manifest omits it, i.e. enabled by default)
   * - row with `enabled = false` => plugin is disabled for that company
   * - row with `enabled = true` => plugin is enabled and stores company settings
   *
   * See server/src/services/plugin-company-enablement.ts for the evaluation.
  ```

- [ ] **3.5 Run — expect pass.**
  ```bash
  pnpm exec vitest run server/src/services/plugin-company-enablement.test.ts
  ```

- [ ] **3.6 Commit.**
  ```bash
  git add server/src/services/plugin-company-enablement.ts server/src/services/plugin-company-enablement.test.ts packages/db/src/schema/plugin_company_settings.ts
  git commit -m "$(cat <<'EOF'
  feat(server): per-company plugin enablement helper service

  Manifest-default-aware (companyEnablement.default) evaluation over
  plugin_company_settings rows, typed 403 plugin_not_enabled_for_company,
  and a fail-open event-bus deliverability checker. Adapted from
  contrib/company-plugin-enablement with the manifest-default delta.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 4: Event-bus company-scoped delivery gate (enforcement point 3/6)

Adapt from `contrib/company-plugin-enablement:server/src/services/plugin-event-bus.ts` and its `server/src/app.ts` wiring — both apply cleanly (verified the current `createPluginEventBus()` at `plugin-event-bus.ts:149` and the current `app.ts:289–291` are byte-identical to that branch's base).

**Files:**
- Modify: `server/src/services/plugin-event-bus.ts` (`createPluginEventBus` at line 149, `emit` at lines 172–198, public-types section near line 305+)
- Modify: `server/src/app.ts` (import block near line 71; event-bus construction at lines 289–291)
- Test (create): `server/src/services/plugin-event-bus.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PluginEventBusOptions {
    isPluginDeliverableForCompany?: (pluginKey: string, companyId: string) => Promise<boolean>;
  }
  export function createPluginEventBus(options: PluginEventBusOptions = {}): PluginEventBus;
  ```
  (Existing zero-arg call sites remain valid.)
- Consumes: `createPluginEventDeliverabilityChecker` from Task 3; `logger` (already imported in `app.ts:60`); `pluginRegistry` (already constructed at `app.ts:289`).

**Steps:**

- [ ] **4.1 Write the failing test.** Create `server/src/services/plugin-event-bus.test.ts` (adapted from contrib/company-plugin-enablement, verbatim semantics):

  ```ts
  import { describe, expect, it, vi } from "vitest";
  import type { PluginEvent } from "@paperclipai/plugin-sdk";
  import { createPluginEventBus } from "./plugin-event-bus.js";

  /**
   * Builds a minimal, well-typed `PluginEvent`. `overrides` lets tests blank
   * out `companyId` to simulate an event without company context (the bus
   * treats a falsy value as "absent" for gating purposes).
   */
  function makeEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
    return {
      eventId: "evt-1",
      eventType: "issue.created",
      occurredAt: new Date().toISOString(),
      companyId: "company-1",
      payload: {},
      ...overrides,
    } as PluginEvent;
  }

  describe("per-company event delivery gate", () => {
    function busWithChecker(deliverable: boolean) {
      const isPluginDeliverableForCompany = vi.fn(async () => deliverable);
      const bus = createPluginEventBus({ isPluginDeliverableForCompany });
      return { bus, isPluginDeliverableForCompany };
    }

    it("skips delivery to a plugin disabled for the event's company", async () => {
      const { bus, isPluginDeliverableForCompany } = busWithChecker(false);
      const handler = vi.fn(async () => {});
      bus.forPlugin("plugin-a").subscribe("issue.created", handler);

      const result = await bus.emit(makeEvent());

      expect(handler).not.toHaveBeenCalled();
      expect(isPluginDeliverableForCompany).toHaveBeenCalledWith("plugin-a", "company-1");
      expect(result.errors).toEqual([]);
    });

    it("delivers when the checker allows", async () => {
      const { bus } = busWithChecker(true);
      const handler = vi.fn(async () => {});
      bus.forPlugin("plugin-a").subscribe("issue.created", handler);

      const result = await bus.emit(makeEvent());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.errors).toEqual([]);
    });

    it("does not consult the checker for events without a companyId", async () => {
      const { bus, isPluginDeliverableForCompany } = busWithChecker(false);
      const handler = vi.fn(async () => {});
      bus.forPlugin("plugin-a").subscribe("activity.logged", handler);

      await bus.emit(makeEvent({
        eventType: "activity.logged",
        companyId: undefined as unknown as string,
      }));

      expect(isPluginDeliverableForCompany).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("memoizes the check per plugin within one emit and re-checks on the next", async () => {
      const { bus, isPluginDeliverableForCompany } = busWithChecker(true);
      const handlerA1 = vi.fn(async () => {});
      const handlerA2 = vi.fn(async () => {});
      bus.forPlugin("plugin-a").subscribe("issue.created", handlerA1);
      bus.forPlugin("plugin-a").subscribe("issue.created", handlerA2);

      await bus.emit(makeEvent());
      expect(isPluginDeliverableForCompany).toHaveBeenCalledTimes(1);
      expect(handlerA1).toHaveBeenCalledTimes(1);
      expect(handlerA2).toHaveBeenCalledTimes(1);

      await bus.emit(makeEvent());
      expect(isPluginDeliverableForCompany).toHaveBeenCalledTimes(2);
    });

    it("fails open (delivers) when the checker throws", async () => {
      const isPluginDeliverableForCompany = vi.fn(async () => {
        throw new Error("enablement lookup failed");
      });
      const bus = createPluginEventBus({ isPluginDeliverableForCompany });
      const handler = vi.fn(async () => {});
      bus.forPlugin("plugin-a").subscribe("issue.created", handler);

      const result = await bus.emit(makeEvent());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.errors).toEqual([]);
    });

    it("keeps the existing no-arg call form working unchanged", async () => {
      const bus = createPluginEventBus();
      const handler = vi.fn(async () => {});
      bus.forPlugin("plugin-a").subscribe("issue.created", handler);

      const result = await bus.emit(makeEvent());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.errors).toEqual([]);
    });
  });
  ```

- [ ] **4.2 Run — expect failure.**
  ```bash
  pnpm exec vitest run server/src/services/plugin-event-bus.test.ts
  ```
  Expected: TypeScript/argument failure on `createPluginEventBus({ ... })` (current signature takes no options) and/or the "skips delivery" test failing because the handler IS called.

- [ ] **4.3 Implement the bus gate.** In `server/src/services/plugin-event-bus.ts`:

  1. Change the signature (line 149):
     ```ts
     export function createPluginEventBus(): PluginEventBus {
     ```
     →
     ```ts
     export function createPluginEventBus(options: PluginEventBusOptions = {}): PluginEventBus {
     ```

  2. Inside `emit` (after `const promises: Promise<void>[] = [];`, line 174), insert:
     ```ts
       // Per-emit, per-plugin memoized enablement check. A fresh cache per call
       // to `emit` keeps this cheap (at most one lookup per plugin per event)
       // without leaking state across unrelated events.
       const deliverableCache = new Map<string, Promise<boolean>>();
       const isDeliverable = (pluginId: string, companyId: string): Promise<boolean> => {
         if (!options.isPluginDeliverableForCompany) return Promise.resolve(true);
         const cached = deliverableCache.get(pluginId);
         if (cached) return cached;
         const result = options
           .isPluginDeliverableForCompany(pluginId, companyId)
           // Fail open: an enablement-lookup failure must not silently drop
           // events. The checker is responsible for logging its own errors.
           .catch(() => true);
         deliverableCache.set(pluginId, result);
         return result;
       };
     ```

  3. Replace the pushed promise (lines 188–192):
     ```ts
             promises.push(
               Promise.resolve().then(() => sub.handler(event)).catch((error: unknown) => {
                 errors.push({ pluginId, error });
               }),
             );
     ```
     →
     ```ts
             promises.push(
               Promise.resolve()
                 .then(async () => {
                   if (event.companyId && !(await isDeliverable(pluginId, event.companyId))) {
                     return;
                   }
                   await sub.handler(event);
                 })
                 .catch((error: unknown) => {
                   errors.push({ pluginId, error });
                 }),
             );
     ```

  4. In the `// Public types` section (before the emit-result type near line 305+), add:
     ```ts
     /**
      * Options for {@link createPluginEventBus}.
      */
     export interface PluginEventBusOptions {
       /**
        * When set, events carrying a (truthy) `companyId` are only delivered to
        * a given plugin's subscriptions when this resolves `true` for
        * `(pluginKey, companyId)` — i.e. per-company plugin enablement. The bus
        * registers subscriptions under the manifest `pluginKey` (see
        * `forPlugin`/`subsFor`), so that is what this checker receives — not
        * the plugin's database uuid. Events without a `companyId` are always
        * delivered and this checker is never consulted for them.
        *
        * If the checker's promise rejects, delivery fails open (the event is
        * still delivered) so an enablement-lookup failure can never silently
        * drop events; the checker is responsible for logging its own errors.
        */
       isPluginDeliverableForCompany?: (
         pluginKey: string,
         companyId: string,
       ) => Promise<boolean>;
     }
     ```

- [ ] **4.4 Wire it in `server/src/app.ts`.** Next to the existing import (line 71):
  ```ts
  import { createPluginEventBus } from "./services/plugin-event-bus.js";
  ```
  add:
  ```ts
  import { createPluginEventDeliverabilityChecker } from "./services/plugin-company-enablement.js";
  ```
  Then replace (lines 289–291):
  ```ts
    const pluginRegistry = pluginRegistryService(db);
    const eventBus = createPluginEventBus();
    setPluginEventBus(eventBus);
  ```
  with:
  ```ts
    const pluginRegistry = pluginRegistryService(db);
    const eventBus = createPluginEventBus({
      isPluginDeliverableForCompany: createPluginEventDeliverabilityChecker(
        pluginRegistry,
        (ctx, msg) => logger.warn(ctx, msg),
      ),
    });
    setPluginEventBus(eventBus);
  ```
  (`logger` is already imported at `app.ts:60`.)

- [ ] **4.5 Run — expect pass**, plus server typecheck:
  ```bash
  pnpm exec vitest run server/src/services/plugin-event-bus.test.ts && pnpm --filter server typecheck
  ```

- [ ] **4.6 Commit.**
  ```bash
  git add server/src/services/plugin-event-bus.ts server/src/services/plugin-event-bus.test.ts server/src/app.ts
  git commit -m "$(cat <<'EOF'
  feat(server): gate company-scoped event delivery on plugin enablement

  Company-scoped events skip subscriptions of plugins disabled for that
  company (manifest default aware); lookup failures fail open so events
  are never silently dropped. Adapted from contrib/company-plugin-enablement.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 5: Host-services gate — replace the documented no-op (enforcement point 1/6)

Adapt from `contrib/company-plugin-enablement:server/src/services/plugin-host-services.ts` (same replacement, new helper API). The no-op `ensurePluginAvailableForCompany` is already awaited by **every** company-scoped host operation (~80 call sites, verified `plugin-host-services.ts` lines 600–2716), so replacing its body gates all of host services at once.

**Files:**
- Modify: `server/src/services/plugin-host-services.ts` (import block near line 45; the no-op at lines 588–593)
- Test (create): `server/src/__tests__/plugin-host-services-company-gate.test.ts`

**Interfaces:**
- Consumes: `pluginCompanyEnablementService` (Task 3); `registry` (already constructed inside `buildHostServices` at line 498: `const registry = pluginRegistryService(db);`); `pluginId` (the `buildHostServices` parameter, line 492 — the plugin's database UUID).
- Produces: no signature changes; `HostServices` methods now reject with the typed 403 when the plugin is company-disabled.

**Steps:**

- [ ] **5.1 Write the failing test.** Create `server/src/__tests__/plugin-host-services-company-gate.test.ts`. It mocks the registry module (same `vi.mock` pattern as `server/src/__tests__/plugin-routes-authz.test.ts:27`) and drives the real `buildHostServices` through its cheapest company-scoped method, `services.config.get` (`plugin-host-services.ts:1062`), which awaits the gate before `registry.getConfig`:

  ```ts
  import { describe, expect, it, vi } from "vitest";

  const mockRegistry = vi.hoisted(() => ({
    getById: vi.fn(),
    getByKey: vi.fn(),
    getConfig: vi.fn(),
    getCompanySettings: vi.fn(),
    upsertCompanySettings: vi.fn(),
  }));

  vi.mock("../services/plugin-registry.js", () => ({
    pluginRegistryService: () => mockRegistry,
  }));

  import { buildHostServices } from "../services/plugin-host-services.js";

  const pluginId = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";

  // Shape mirrors createEventBusStub in plugin-access-authorization-host-services.test.ts:22.
  function createEventBusStub() {
    return {
      forPlugin() {
        return {
          emit: vi.fn(),
          subscribe: vi.fn(),
          clear: vi.fn(),
        };
      },
    } as never;
  }

  function build() {
    // buildHostServices only *captures* db in service factories; no query runs
    // until a service method is invoked, so an empty object is sufficient here.
    return buildHostServices({} as never, pluginId, "paperclip.example", createEventBusStub());
  }

  describe("host services per-company enablement gate", () => {
    it("rejects company-scoped host calls when the plugin is disabled for the company", async () => {
      mockRegistry.getById.mockResolvedValue({ id: pluginId, manifestJson: {} });
      mockRegistry.getCompanySettings.mockResolvedValue({ enabled: false });
      const services = build();

      await expect(services.config.get({ companyId })).rejects.toMatchObject({
        status: 403,
        details: { code: "plugin_not_enabled_for_company" },
      });
      expect(mockRegistry.getConfig).not.toHaveBeenCalled();
      services.dispose();
    });

    it("allows company-scoped host calls when no settings row exists (default on)", async () => {
      mockRegistry.getById.mockResolvedValue({ id: pluginId, manifestJson: {} });
      mockRegistry.getCompanySettings.mockResolvedValue(null);
      mockRegistry.getConfig.mockResolvedValue({ configJson: { greeting: "hi" } });
      const services = build();

      await expect(services.config.get({ companyId })).resolves.toEqual({ greeting: "hi" });
      expect(mockRegistry.getCompanySettings).toHaveBeenCalledWith(pluginId, companyId);
      services.dispose();
    });

    it('respects manifest default "off" when no settings row exists', async () => {
      mockRegistry.getById.mockResolvedValue({
        id: pluginId,
        manifestJson: { companyEnablement: { default: "off" } },
      });
      mockRegistry.getCompanySettings.mockResolvedValue(null);
      const services = build();

      await expect(services.config.get({ companyId })).rejects.toMatchObject({ status: 403 });
      services.dispose();
    });
  });
  ```

  Contingency: if `buildHostServices({} as never, …)` throws at construction because some transitively constructed service factory eagerly touches the db (none was found on inspection — all follow the `(db) => api` capture pattern), mock that specific service module the same way `plugin-registry.js` is mocked above, and note it in the commit message.

- [ ] **5.2 Run — expect failure.**
  ```bash
  pnpm exec vitest run server/src/__tests__/plugin-host-services-company-gate.test.ts
  ```
  Expected: test 1 and 3 fail — `config.get` resolves instead of rejecting (the gate is still the no-op).

- [ ] **5.3 Implement.** In `server/src/services/plugin-host-services.ts`:

  1. Add to the service imports (next to `import { pluginRegistryService } from "./plugin-registry.js";`, line ~45):
     ```ts
     import { pluginCompanyEnablementService } from "./plugin-company-enablement.js";
     ```

  2. Replace the no-op (lines 588–593):
     ```ts
       /**
        * Plugins are instance-wide in the current runtime. Company IDs are still
        * required for company-scoped data access, but there is no per-company
        * availability gate to enforce here.
        */
       const ensurePluginAvailableForCompany = async (_companyId: string) => {};
     ```
     with:
     ```ts
       /**
        * Per-company availability gate: companies can disable an installed
        * plugin via plugin_company_settings (manifest `companyEnablement`
        * default applies when no row exists). Every company-scoped host
        * operation awaits this before touching company data; a disabled
        * plugin gets the typed 403 `plugin_not_enabled_for_company`.
        */
       const companyEnablement = pluginCompanyEnablementService(registry);
       const ensurePluginAvailableForCompany = async (companyId: string) => {
         await companyEnablement.ensurePluginEnabledForCompany(pluginId, companyId);
       };
     ```
     (`registry` and `pluginId` are already in scope — lines 498 and 492.)

- [ ] **5.4 Run — expect pass**, then regression-run the existing host-services suites (embedded-postgres suites auto-skip where unsupported):
  ```bash
  pnpm exec vitest run server/src/__tests__/plugin-host-services-company-gate.test.ts
  pnpm exec vitest run server/src/__tests__/plugin-orchestration-apis.test.ts server/src/__tests__/plugin-access-authorization-host-services.test.ts
  ```
  Expected: all pass (or skip). NOTE from prior art: if these embedded-postgres suites run and fail on `getCompanySettings` with a uuid-cast error, it is because they build host services with the literal pluginId `"plugin-record-id"`, which now reaches a uuid-typed query through the gate. Fix exactly as contrib/company-plugin-enablement did (commits shown in `plugin-orchestration-apis.test.ts` / `plugin-access-authorization-host-services.test.ts` diffs): replace `const pluginId = "plugin-record-id";` with `const pluginId = randomUUID();` and use that variable at every `buildHostServices(db, pluginId, …)` / assertion site in those two files (`randomUUID` is already imported in both).

- [ ] **5.5 Commit.**
  ```bash
  git add server/src/services/plugin-host-services.ts server/src/__tests__/plugin-host-services-company-gate.test.ts
  git add -u server/src/__tests__/plugin-orchestration-apis.test.ts server/src/__tests__/plugin-access-authorization-host-services.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): enforce per-company plugin enablement in host services

  Replaces the documented no-op ensurePluginAvailableForCompany; every
  company-scoped host operation now fails closed with the typed 403 when
  the plugin is disabled for that company.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 6: Company plugin catalog + enablement toggle routes

Adapt from `contrib/company-plugin-enablement:server/src/routes/plugins.ts` (catalog/enablement section) with three designed deltas: catalog item carries `locked`/`defaultEnabled`/`hasCompanySettingsPage` and computes `enabled` manifest-aware; the toggle requires `plugins:manage` and 409s on `locked`; the catalog read requires PR-1's `assertSurfaceExposed`.

**Files:**
- Modify: `server/src/routes/plugins.ts`:
  - shared-type import block (lines 38–47), errors import (line 88), authz import (lines 67–75), service imports (after line 48)
  - inside `pluginRoutes(...)` after `const issuesSvc = issueService(db);` (line 523): service construction
  - after `assertPluginBridgeScope` (lines 707–717): new authz helpers
  - route-table doc comment (lines ~470–497 region): two new rows
  - new route section inserted immediately BEFORE the `// Plugin health dashboard — aggregated diagnostics for the settings page` banner near the end of the file (search for that exact comment)
- Test: `server/src/__tests__/plugin-routes-authz.test.ts` (mock additions at top; new `describe` block appended)

**Interfaces:**
- Produces routes:
  - `GET /api/plugins/companies/:companyId/catalog` → `CompanyPluginCatalogItem[]`
  - `PUT /api/plugins/:pluginId/companies/:companyId/enablement`, body `{ enabled: boolean }` → updated `CompanyPluginCatalogItem`; 409 `plugin_enablement_locked` for locked plugins when the actor is not an instance admin; 400 non-boolean body; 404 unknown plugin.
- Produces type (route-local, mirrored in the UI api client in Task 9):
  ```ts
  type CompanyPluginCatalogItem = {
    pluginId: string;
    pluginKey: string;
    displayName: string;
    version: string;
    description: string | null;
    capabilities: string[];
    enabled: boolean;
    locked: boolean;
    defaultEnabled: boolean;
    hasCompanySettingsPage: boolean;
    settingsRoutePath: string | null;
  };
  ```
  (Pinned contract fields `pluginId, displayName, description, enabled, locked, defaultEnabled, hasCompanySettingsPage` plus `pluginKey`/`version`/`settingsRoutePath` — the UI list page needs those for badges and the settings deep link (`hasCompanySettingsPage` alone cannot produce the link target `/company/settings/${routePath}`) — plus `capabilities` because spec §4.5 requires a "capability summary" on the catalog page.)
- Consumes:
  - `assertSurfaceExposed(req, surface, getExposedSurfaces)` from `server/src/routes/authz.ts` (PR-1; see Global Constraints). Called as `await assertSurfaceExposed(req, "company.plugins", getExposedCompanySurfaces)` where `getExposedCompanySurfaces` is the factory-level resolver `async () => (await instanceSettingsService(db).getVisibility()).companySurfaces` (PR-1's canonical caller pattern; authz.ts is DB-free by design).
  - `accessService(db).canUser(companyId, userId, "plugins:manage")` and `.hasPermission(companyId, "agent", agentId, "plugins:manage")` (`server/src/services/access.ts:74/59`) — the same enforcement shape as `assertCompanyPermission` in `server/src/routes/access.ts:2989`.
  - `pluginCompanyEnablementService` / `evaluateCompanyEnablement` (Task 3), `registry.listByStatus/getCompanySettings/upsertCompanySettings` (`plugin-registry.ts:117/397/408` — the upsert overwrites `settingsJson` and `lastError` wholesale, so the route round-trips the existing row), `resolvePlugin` (`plugins.ts:357`), `logPluginMutationActivity` (`plugins.ts:683`), `conflict` from `../errors.js`.

**Steps:**

- [ ] **6.1 Write the failing tests.** In `server/src/__tests__/plugin-routes-authz.test.ts`:

  1. Extend the hoisted registry mock (lines 5–12) with `listByStatus`:
     ```ts
     const mockRegistry = vi.hoisted(() => ({
       getById: vi.fn(),
       getByKey: vi.fn(),
       getConfig: vi.fn(),
       upsertConfig: vi.fn(),
       getCompanySettings: vi.fn(),
       upsertCompanySettings: vi.fn(),
       listByStatus: vi.fn(),
     }));
     ```

  2. After the existing `vi.mock("../services/live-events.js", ...)` block (line 43–45), add mocks for the access service and PR-1's surface gate (partial mock keeps every other real authz helper):
     ```ts
     const mockAccess = vi.hoisted(() => ({
       canUser: vi.fn(),
       hasPermission: vi.fn(),
     }));

     vi.mock("../services/access.js", () => ({
       accessService: () => mockAccess,
     }));

     const mockAssertSurfaceExposed = vi.hoisted(() => vi.fn(async () => {}));

     vi.mock("../routes/authz.js", async (importOriginal) => ({
       ...(await importOriginal<typeof import("../routes/authz.js")>()),
       assertSurfaceExposed: mockAssertSurfaceExposed,
     }));
     ```

  3. Add a static import at the top of the file (below the existing imports):
     ```ts
     import { forbidden } from "../errors.js";
     ```

  4. Below the existing `readyPlugin()` helper (line 139–146), add a catalog fixture factory:
     ```ts
     function catalogPluginRecord(
       overrides: Record<string, unknown> = {},
       manifestOverrides: Record<string, unknown> = {},
     ) {
       return {
         id: pluginId,
         pluginKey: "paperclip.example",
         version: "1.0.0",
         status: "ready",
         categories: ["workspace"],
         updatedAt: new Date("2024-01-01T00:00:00.000Z"),
         manifestJson: {
           id: "paperclip.example",
           displayName: "Example Plugin",
           description: "An example plugin",
           ui: {
             slots: [
               {
                 type: "companySettingsPage",
                 id: "settings",
                 displayName: "Settings",
                 exportName: "Settings",
                 routePath: "example",
               },
             ],
           },
           ...manifestOverrides,
         },
         ...overrides,
       };
     }
     ```

  5. Append this `describe` block at the end of the file:

     ```ts
     describe.sequential("company plugin catalog and enablement authz", () => {
       beforeEach(() => {
         vi.clearAllMocks();
         mockAssertSurfaceExposed.mockResolvedValue(undefined);
         mockAccess.canUser.mockResolvedValue(true);
         mockAccess.hasPermission.mockResolvedValue(true);
       });

       it("lists catalog items with manifest-aware enabled state and metadata", async () => {
         mockRegistry.listByStatus.mockResolvedValueOnce([catalogPluginRecord()]);
         mockRegistry.getCompanySettings.mockResolvedValueOnce({ enabled: false });
         const { app } = await createApp(boardActor());

         const res = await request(app).get(`/api/plugins/companies/${companyA}/catalog`);

         expect(res.status).toBe(200);
         expect(res.body).toEqual([
           {
             pluginId,
             pluginKey: "paperclip.example",
             displayName: "Example Plugin",
             version: "1.0.0",
             description: "An example plugin",
             capabilities: [],
             enabled: false,
             locked: false,
             defaultEnabled: true,
             hasCompanySettingsPage: true,
             settingsRoutePath: "example",
           },
         ]);
         expect(mockRegistry.listByStatus).toHaveBeenCalledWith("ready");
       });

       it("reports default-off plugins as disabled when no row exists", async () => {
         mockRegistry.listByStatus.mockResolvedValueOnce([
           catalogPluginRecord({}, { companyEnablement: { default: "off" } }),
         ]);
         mockRegistry.getCompanySettings.mockResolvedValueOnce(null);
         const { app } = await createApp(boardActor());

         const res = await request(app).get(`/api/plugins/companies/${companyA}/catalog`);

         expect(res.status).toBe(200);
         expect(res.body[0]).toMatchObject({ enabled: false, defaultEnabled: false, locked: false });
       });

       it("excludes sandbox-provider-only infrastructure plugins from the catalog", async () => {
         mockRegistry.listByStatus.mockResolvedValueOnce([
           catalogPluginRecord(
             { id: "99999999-9999-4999-8999-999999999999", pluginKey: "paperclip.kubernetes-sandbox-provider" },
             {
               ui: undefined,
               environmentDrivers: [
                 { driverKey: "kubernetes", kind: "sandbox_provider", displayName: "Kubernetes" },
               ],
             },
           ),
           catalogPluginRecord(),
         ]);
         mockRegistry.getCompanySettings.mockResolvedValueOnce(null);
         const { app } = await createApp(boardActor());

         const res = await request(app).get(`/api/plugins/companies/${companyA}/catalog`);

         expect(res.status).toBe(200);
         expect(res.body).toHaveLength(1);
         expect(res.body[0].pluginKey).toBe("paperclip.example");
       });

       it("requires the company.plugins surface (PR-1 gate) on catalog reads", async () => {
         mockAssertSurfaceExposed.mockImplementationOnce(async () => {
           throw forbidden("Surface is not exposed", { code: "surface_not_exposed" });
         });
         const { app } = await createApp(boardActor());

         const res = await request(app).get(`/api/plugins/companies/${companyA}/catalog`);

         expect(res.status).toBe(403);
         expect(res.body.code).toBe("surface_not_exposed");
         expect(mockAssertSurfaceExposed).toHaveBeenCalledWith(
           expect.anything(),
           "company.plugins",
         );
         expect(mockRegistry.listByStatus).not.toHaveBeenCalled();
       });

       it("rejects catalog reads from a member of another company", async () => {
         const { app } = await createApp(boardActor({ companyIds: [companyB] }));

         const res = await request(app).get(`/api/plugins/companies/${companyA}/catalog`);

         expect(res.status).toBe(403);
         expect(mockRegistry.listByStatus).not.toHaveBeenCalled();
       });

       it("toggles enablement, preserving settingsJson and lastError", async () => {
         mockRegistry.getById.mockResolvedValue(catalogPluginRecord());
         mockRegistry.getCompanySettings.mockResolvedValue({
           enabled: true,
           settingsJson: { keep: "me" },
           lastError: "previous failure",
         });
         mockRegistry.upsertCompanySettings.mockResolvedValueOnce({
           enabled: false,
           settingsJson: { keep: "me" },
           lastError: "previous failure",
         });
         const { app } = await createApp(boardActor());

         const res = await request(app)
           .put(`/api/plugins/${pluginId}/companies/${companyA}/enablement`)
           .send({ enabled: false });

         expect(res.status).toBe(200);
         expect(res.body).toMatchObject({ pluginId, enabled: false });
         expect(mockAccess.canUser).toHaveBeenCalledWith(companyA, "user-1", "plugins:manage");
         expect(mockRegistry.upsertCompanySettings).toHaveBeenCalledWith(
           pluginId,
           companyA,
           { enabled: false, settingsJson: { keep: "me" }, lastError: "previous failure" },
         );
       });

       it("rejects toggles from members without plugins:manage", async () => {
         mockAccess.canUser.mockResolvedValue(false);
         mockRegistry.getById.mockResolvedValue(catalogPluginRecord());
         const { app } = await createApp(boardActor());

         const res = await request(app)
           .put(`/api/plugins/${pluginId}/companies/${companyA}/enablement`)
           .send({ enabled: false });

         expect(res.status).toBe(403);
         expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
       });

       it("rejects toggles from viewers before the permission check (write-path company access)", async () => {
         const { app } = await createApp(boardActor({
           memberships: [
             { companyId: companyA, status: "active", membershipRole: "viewer" },
           ],
         }));

         const res = await request(app)
           .put(`/api/plugins/${pluginId}/companies/${companyA}/enablement`)
           .send({ enabled: false });

         expect(res.status).toBe(403);
         expect(mockAccess.canUser).not.toHaveBeenCalled();
         expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
       });

       it("returns 409 plugin_enablement_locked when a non-admin toggles a locked plugin", async () => {
         mockRegistry.getById.mockResolvedValue(
           catalogPluginRecord({}, { companyEnablement: { default: "off", locked: true } }),
         );
         const { app } = await createApp(boardActor());

         const res = await request(app)
           .put(`/api/plugins/${pluginId}/companies/${companyA}/enablement`)
           .send({ enabled: true });

         expect(res.status).toBe(409);
         expect(res.body.code).toBe("plugin_enablement_locked");
         expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
       });

       it("lets an instance admin toggle a locked plugin", async () => {
         mockRegistry.getById.mockResolvedValue(
           catalogPluginRecord({}, { companyEnablement: { default: "off", locked: true } }),
         );
         mockRegistry.getCompanySettings.mockResolvedValue(null);
         mockRegistry.upsertCompanySettings.mockResolvedValueOnce({
           enabled: true,
           settingsJson: {},
           lastError: null,
         });
         const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

         const res = await request(app)
           .put(`/api/plugins/${pluginId}/companies/${companyA}/enablement`)
           .send({ enabled: true });

         expect(res.status).toBe(200);
         expect(res.body).toMatchObject({ enabled: true, locked: true, defaultEnabled: false });
         expect(mockRegistry.upsertCompanySettings).toHaveBeenCalledWith(
           pluginId,
           companyA,
           { enabled: true, settingsJson: {}, lastError: null },
         );
       });

       it("rejects a non-boolean enabled value", async () => {
         mockRegistry.getById.mockResolvedValue(catalogPluginRecord());
         const { app } = await createApp(boardActor());

         const res = await request(app)
           .put(`/api/plugins/${pluginId}/companies/${companyA}/enablement`)
           .send({ enabled: "yes" });

         expect(res.status).toBe(400);
         expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
       });
     });
     ```

- [ ] **6.2 Run — expect failure.**
  ```bash
  pnpm exec vitest run server/src/__tests__/plugin-routes-authz.test.ts
  ```
  Expected: all new tests fail with 404s (routes don't exist). All pre-existing tests in the file must still pass (the partial authz mock and new access mock must not disturb them) — if any pre-existing test breaks here, fix the mock wiring before proceeding.

- [ ] **6.3 Implement imports and helpers in `server/src/routes/plugins.ts`.**

  1. Type imports (lines 38–44): add `PluginRecord`:
     ```ts
     import type {
       PluginApiRouteDeclaration,
       PluginStatus,
       PaperclipPluginManifestV1,
       PluginBridgeErrorCode,
       PluginLauncherRenderContextSnapshot,
       PluginRecord,
     } from "@paperclipai/shared";
     ```

  2. Service imports: after `import { pluginRegistryService } from "../services/plugin-registry.js";` (line 48) add:
     ```ts
     import { accessService } from "../services/access.js";
     import {
       evaluateCompanyEnablement,
       pluginCompanyEnablementService,
     } from "../services/plugin-company-enablement.js";
     ```

  3. Authz imports (lines 67–75): add `assertSurfaceExposed`:
     ```ts
     import {
       assertAuthenticated,
       assertBoard,
       assertBoardOrAgent,
       assertBoardOrgAccess,
       assertCompanyAccess,
       assertInstanceAdmin,
       assertSurfaceExposed,
       getActorInfo,
     } from "./authz.js";
     ```

  3b. Resolver setup (PR-1 caller pattern): add to the services import block `import { instanceSettingsService } from "../services/instance-settings.js";` and, inside the route factory right after the existing service constructions, add:
     ```ts
     const instanceSettingsSvc = instanceSettingsService(db);
     const getExposedCompanySurfaces = async () =>
       (await instanceSettingsSvc.getVisibility()).companySurfaces;
     ```
     (If the plugins route factory receives `registry` but no `db` handle, thread `db` in the same way the factory's existing service dependencies are constructed at its `app.ts` wiring site — mirror how PR-1 does this in `secretRoutes(db)`.)

  4. Errors import (line 88): add `conflict`:
     ```ts
     import { badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
     ```

  5. Route-local type: after the `PluginUiContribution` type (line 113) add:
     ```ts
     /**
      * Company-facing catalog item combining a `ready` plugin's manifest
      * metadata with its per-company enablement state. Returned by the company
      * plugin catalog and enablement routes; consumed by the CompanyPlugins UI
      * page (ui/src/pages/CompanyPlugins.tsx).
      */
     type CompanyPluginCatalogItem = {
       pluginId: string;
       pluginKey: string;
       displayName: string;
       version: string;
       description: string | null;
       capabilities: string[];
       enabled: boolean;
       locked: boolean;
       defaultEnabled: boolean;
       hasCompanySettingsPage: boolean;
       settingsRoutePath: string | null;
     };
     ```

  6. Inside `pluginRoutes(...)`, after `const issuesSvc = issueService(db);` (line 523) add:
     ```ts
       const access = accessService(db);
       const enablement = pluginCompanyEnablementService(registry);
     ```

  7. After the `assertPluginBridgeScope` function (lines 707–717) add:
     ```ts
       /** Board actor that is an instance admin (mirrors authz.assertInstanceAdmin). */
       function isInstanceAdminActor(req: Request): boolean {
         return req.actor.type === "board"
           && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true);
       }

       /**
        * `plugins:manage` gate for the company enablement toggle. Owner/admin
        * memberships hold it implicitly via role default grants; other
        * principals need an explicit principal_permission_grants row.
        * Enforcement shape mirrors assertCompanyPermission in routes/access.ts.
        */
       async function assertPluginsManagePermission(req: Request, companyId: string): Promise<void> {
         if (req.actor.type === "agent") {
           if (!req.actor.agentId) throw forbidden("Agent authentication required");
           const allowed = await access.hasPermission(companyId, "agent", req.actor.agentId, "plugins:manage");
           if (!allowed) throw forbidden('Permission "plugins:manage" is required');
           return;
         }
         if (req.actor.type !== "board") throw unauthorized();
         if (isInstanceAdminActor(req)) return;
         const allowed = await access.canUser(companyId, req.actor.userId, "plugins:manage");
         if (!allowed) throw forbidden('Permission "plugins:manage" is required');
       }
     ```

- [ ] **6.4 Implement the routes.** In `server/src/routes/plugins.ts`, find the section banner near the end of the file:
  ```ts
  // ===========================================================================
  // Plugin health dashboard — aggregated diagnostics for the settings page
  // ===========================================================================
  ```
  and insert BEFORE it:

  ```ts
    // ===========================================================================
    // Company plugin catalog & enablement
    // ===========================================================================

    /** Route path of a plugin's declared `companySettingsPage` UI slot, if any. */
    function companySettingsPageRoutePath(manifest: PaperclipPluginManifestV1): string | null {
      const page = manifest.ui?.slots?.find(
        (slot) => slot.type === "companySettingsPage" && slot.routePath,
      );
      return page?.routePath ?? null;
    }

    /**
     * Infrastructure plugins (sandbox providers / credential brokers) have no
     * company-facing surface, so they stay out of the company catalog. This
     * codebase identifies them via `environmentDrivers[].kind ===
     * "sandbox_provider"` (there is no dedicated manifest category) — the same
     * predicate as isSandboxProviderOnly in ui/src/components/CompanySettingsSidebar.tsx.
     */
    function isInfrastructureOnlyPlugin(manifest: PaperclipPluginManifestV1 | null): boolean {
      const drivers = manifest?.environmentDrivers ?? [];
      if (drivers.length === 0) return false;
      return drivers.every((driver) => driver.kind === "sandbox_provider");
    }

    function toCompanyPluginCatalogItem(
      plugin: PluginRecord,
      settings: { enabled: boolean } | null,
    ): CompanyPluginCatalogItem {
      const manifest = plugin.manifestJson;
      const settingsRoutePath = companySettingsPageRoutePath(manifest);
      return {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        displayName: manifest.displayName ?? plugin.pluginKey,
        version: plugin.version,
        description: manifest.description ?? null,
        capabilities: manifest.capabilities ?? [],
        enabled: evaluateCompanyEnablement(manifest, settings),
        locked: manifest.companyEnablement?.locked === true,
        defaultEnabled: (manifest.companyEnablement?.default ?? "on") === "on",
        hasCompanySettingsPage: settingsRoutePath !== null,
        settingsRoutePath,
      };
    }

    /**
     * GET /api/plugins/companies/:companyId/catalog
     *
     * Company-facing catalog of `ready`, catalog-eligible plugins annotated
     * with per-company enablement state (manifest `companyEnablement` default
     * + plugin_company_settings row), lock state, and the route path of a
     * declared `companySettingsPage` slot.
     *
     * Authz: active company access + the PR-1 `company.plugins` settings
     * surface. Infrastructure (sandbox-provider-only) plugins are excluded.
     *
     * Response: `CompanyPluginCatalogItem[]`
     */
    router.get("/plugins/companies/:companyId/catalog", async (req, res) => {
      assertBoardOrgAccess(req);
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      await assertSurfaceExposed(req, "company.plugins", getExposedCompanySurfaces);

      const plugins = await registry.listByStatus("ready");
      const items = await Promise.all(
        plugins
          .filter((plugin) => !isInfrastructureOnlyPlugin(plugin.manifestJson))
          .map(async (plugin) =>
            toCompanyPluginCatalogItem(
              plugin,
              await registry.getCompanySettings(plugin.id, companyId),
            )),
      );
      res.json(items);
    });

    /**
     * PUT /api/plugins/:pluginId/companies/:companyId/enablement
     *
     * Toggle whether a plugin is enabled for a company.
     *
     * Authz: active company access (write path) + `plugins:manage`
     * (implicitly held by owner/admin memberships, grantable via
     * principal_permission_grants; instance admins bypass).
     *
     * Locked plugins (`manifest.companyEnablement.locked`) reject non-admin
     * toggles with 409 `plugin_enablement_locked`; only instance admins may
     * write per-company overrides for them.
     *
     * Reads the existing plugin_company_settings row and round-trips its
     * `settingsJson`/`lastError` — the registry upsert overwrites both
     * wholesale, so this route must preserve them.
     *
     * Body: `{ enabled: boolean }`
     * Response: `CompanyPluginCatalogItem` (the updated item)
     * Errors: 400 non-boolean `enabled`, 404 unknown plugin, 409 locked.
     */
    router.put("/plugins/:pluginId/companies/:companyId/enablement", async (req, res) => {
      assertBoardOrgAccess(req);
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      await assertPluginsManagePermission(req, companyId);

      const plugin = await resolvePlugin(registry, req.params.pluginId);
      if (!plugin) throw notFound("Plugin not found");

      const { enabled } = (req.body ?? {}) as { enabled?: unknown };
      if (typeof enabled !== "boolean") {
        throw badRequest('"enabled" must be a boolean');
      }

      if (plugin.manifestJson?.companyEnablement?.locked === true && !isInstanceAdminActor(req)) {
        throw conflict("Plugin enablement is managed by the instance", {
          code: "plugin_enablement_locked",
        });
      }

      const existing = await registry.getCompanySettings(plugin.id, companyId);
      const updated = await registry.upsertCompanySettings(plugin.id, companyId, {
        enabled,
        settingsJson: existing?.settingsJson ?? {},
        lastError: existing?.lastError ?? null,
      });
      await logPluginMutationActivity(
        req,
        enabled ? "plugin.company_enabled" : "plugin.company_disabled",
        plugin.id,
        { companyId },
      );

      res.json(toCompanyPluginCatalogItem(plugin, updated));
    });

  ```

  Also add the two routes to the route-table doc comment (the `| GET | /plugins/:pluginId/dashboard | ... |` table around line 495):
  ```
   * | GET | /plugins/companies/:companyId/catalog | Company-scoped catalog of ready plugins with enabled state |
   * | PUT | /plugins/:pluginId/companies/:companyId/enablement | Toggle a plugin's enabled state for a company |
  ```
  (Route-ordering note: `/plugins/companies/:companyId/catalog` never collides with `GET /plugins/:pluginId` — Express only matches the latter for single-segment paths after `/plugins`.)

- [ ] **6.5 Run — expect pass** (new block green, zero regressions in the file):
  ```bash
  pnpm exec vitest run server/src/__tests__/plugin-routes-authz.test.ts && pnpm --filter server typecheck
  ```
  (Typecheck requires PR-1's `assertSurfaceExposed` export — see Global Constraints.)

- [ ] **6.6 Commit.**
  ```bash
  git add server/src/routes/plugins.ts server/src/__tests__/plugin-routes-authz.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): company plugin catalog and enablement routes

  GET /plugins/companies/:companyId/catalog (surface-gated via PR-1
  company.plugins, infrastructure plugins excluded, manifest-aware enabled
  state) and PUT /plugins/:pluginId/companies/:companyId/enablement
  (plugins:manage required, 409 plugin_enablement_locked for locked
  plugins, settingsJson/lastError preserved on toggle).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 7: Enforcement — bridge data/actions, SSE stream, and scoped API routes (points 2 & 5 of 6)

Adapt from `contrib/company-plugin-enablement:server/src/routes/plugins.ts` (bridge/scoped-api hunks) — identical placement; the only delta is calling the Task 3 service (manifest-aware) instead of the row-only helper.

**Files:**
- Modify: `server/src/routes/plugins.ts`:
  - new helper after `assertPluginBridgeScope` (lines 707–717)
  - bridge call sites: line 1377 (`POST /plugins/:pluginId/bridge/data`), line 1470 (`POST /plugins/:pluginId/bridge/action`), line 1564 (`POST /plugins/:pluginId/data/:key`), line 1654 (`POST /plugins/:pluginId/actions/:key`)
  - SSE stream: after `assertCompanyAccess(req, companyId);` at line 1729 (`GET /plugins/:pluginId/bridge/stream/:channel`)
  - scoped API mount: after `assertCompanyAccess(req, companyId);` at line 1818 (`router.use("/plugins/:pluginId/api", ...)`)
- Test: `server/src/__tests__/plugin-routes-authz.test.ts` (append), `server/src/__tests__/plugin-scoped-api-routes.test.ts` (mock addition + append)

**Interfaces:**
- Consumes: `enablement.ensurePluginEnabledForCompany(plugin.id, companyId)` (Task 3 service, constructed in Task 6 step 6.3.6); `assertPluginBridgeScope` (`plugins.ts:707` — `undefined` return means instance-scoped: instance-admin-only and NOT enablement-gated).
- Produces (new route-scope helper):
  ```ts
  async function assertPluginBridgeScopeWithEnablement(
    req: Request,
    pluginRecordId: string,
    companyId: unknown,
  ): Promise<string | undefined>;
  ```

**Steps:**

- [ ] **7.1 Write the failing tests.**

  1. Append to `server/src/__tests__/plugin-routes-authz.test.ts`:

     ```ts
     describe.sequential("per-company plugin enablement on bridge routes", () => {
       beforeEach(() => {
         vi.clearAllMocks();
       });

       it("returns the typed 403 for bridge/data when the plugin is disabled for the company", async () => {
         readyPlugin();
         mockRegistry.getCompanySettings.mockResolvedValueOnce({ enabled: false });
         const call = vi.fn();
         const { app } = await createApp(boardActor(), {}, {
           bridgeDeps: { workerManager: { call } },
         });

         const res = await request(app)
           .post(`/api/plugins/${pluginId}/bridge/data`)
           .send({ companyId: companyA, key: "health", params: {} });

         expect(res.status).toBe(403);
         expect(res.body.code).toBe("plugin_not_enabled_for_company");
         expect(call).not.toHaveBeenCalled();
       });

       it("allows bridge/data when no company settings row exists", async () => {
         readyPlugin();
         mockRegistry.getCompanySettings.mockResolvedValueOnce(null);
         const call = vi.fn().mockResolvedValue({ ok: true });
         const { app } = await createApp(boardActor(), {}, {
           bridgeDeps: { workerManager: { call } },
         });

         const res = await request(app)
           .post(`/api/plugins/${pluginId}/bridge/data`)
           .send({ companyId: companyA, key: "health", params: {} });

         expect(res.status).not.toBe(403);
         expect(call).toHaveBeenCalled();
       });

       it("does not gate instance-scoped bridge/data calls (no companyId)", async () => {
         readyPlugin();
         const call = vi.fn().mockResolvedValue({ ok: true });
         const { app } = await createApp(
           boardActor({ userId: "admin-1", isInstanceAdmin: true, companyIds: [] }),
           {},
           { bridgeDeps: { workerManager: { call } } },
         );

         const res = await request(app)
           .post(`/api/plugins/${pluginId}/bridge/data`)
           .send({ key: "health", params: {} });

         expect(mockRegistry.getCompanySettings).not.toHaveBeenCalled();
         expect(res.status).not.toBe(403);
       });

       it("returns 403 for bridge/action when the plugin is disabled for the company", async () => {
         readyPlugin();
         mockRegistry.getCompanySettings.mockResolvedValueOnce({ enabled: false });
         const call = vi.fn();
         const { app } = await createApp(boardActor(), {}, {
           bridgeDeps: { workerManager: { call } },
         });

         const res = await request(app)
           .post(`/api/plugins/${pluginId}/bridge/action`)
           .send({ companyId: companyA, key: "sync", params: {} });

         expect(res.status).toBe(403);
         expect(call).not.toHaveBeenCalled();
       });

       it("returns 403 for data/:key when the plugin is disabled for the company", async () => {
         readyPlugin();
         mockRegistry.getCompanySettings.mockResolvedValueOnce({ enabled: false });
         const call = vi.fn();
         const { app } = await createApp(boardActor(), {}, {
           bridgeDeps: { workerManager: { call } },
         });

         const res = await request(app)
           .post(`/api/plugins/${pluginId}/data/health`)
           .send({ companyId: companyA, params: {} });

         expect(res.status).toBe(403);
         expect(call).not.toHaveBeenCalled();
       });

       it("returns 403 for actions/:key when the plugin is disabled for the company", async () => {
         readyPlugin();
         mockRegistry.getCompanySettings.mockResolvedValueOnce({ enabled: false });
         const call = vi.fn();
         const { app } = await createApp(boardActor(), {}, {
           bridgeDeps: { workerManager: { call } },
         });

         const res = await request(app)
           .post(`/api/plugins/${pluginId}/actions/sync`)
           .send({ companyId: companyA, params: {} });

         expect(res.status).toBe(403);
         expect(call).not.toHaveBeenCalled();
       });

       it("returns 403 for the bridge SSE stream when the plugin is disabled for the company", async () => {
         readyPlugin();
         mockRegistry.getCompanySettings.mockResolvedValueOnce({ enabled: false });
         const subscribe = vi.fn();
         const { app } = await createApp(boardActor(), {}, {
           bridgeDeps: { streamBus: { subscribe } },
         });

         const res = await request(app)
           .get(`/api/plugins/${pluginId}/bridge/stream/updates`)
           .query({ companyId: companyA });

         expect(res.status).toBe(403);
         expect(subscribe).not.toHaveBeenCalled();
       });
     });
     ```

     NOTE on `readyPlugin()` in this file: it sets `mockRegistry.getById.mockResolvedValue({...})` persistently WITHOUT `manifestJson`. The enablement service calls `getById` again and evaluates `manifestJson === undefined` ⇒ default "on" ⇒ the settings-row mock decides. That is exactly the intended default-on behavior, so the fixture needs no change.

  2. In `server/src/__tests__/plugin-scoped-api-routes.test.ts`, add `getCompanySettings: vi.fn(),` to the hoisted `mockRegistry` (lines 6–9), then append inside the existing `describe.sequential("plugin scoped API routes", ...)` block (adapt from contrib/company-plugin-enablement, verbatim — its `createApp({ actor, plugin })` harness is unchanged in this worktree):

     ```ts
       it("returns 403 and does not dispatch when the plugin is disabled for the company", async () => {
         const apiRoutes = manifest([
           {
             routeKey: "summary.get",
             method: "GET",
             path: "/summary",
             auth: "board",
             capability: "api.routes.register",
             companyResolution: { from: "query", key: "companyId" },
           },
         ]);
         mockRegistry.getCompanySettings.mockResolvedValueOnce({ enabled: false });
         const { app, workerManager } = await createApp({
           actor: {
             type: "board",
             userId: "user-1",
             source: "local_implicit",
             isInstanceAdmin: true,
           },
           plugin: {
             id: pluginId,
             pluginKey: apiRoutes.id,
             status: "ready",
             manifestJson: apiRoutes,
           },
         });

         const res = await request(app)
           .get(`/api/plugins/${pluginId}/api/summary?companyId=${companyId}`);

         expect(res.status).toBe(403);
         expect(mockRegistry.getCompanySettings).toHaveBeenCalledWith(pluginId, companyId);
         expect(workerManager.call).not.toHaveBeenCalled();
       });

       it("dispatches when no company settings row exists for the plugin", async () => {
         const apiRoutes = manifest([
           {
             routeKey: "summary.get",
             method: "GET",
             path: "/summary",
             auth: "board",
             capability: "api.routes.register",
             companyResolution: { from: "query", key: "companyId" },
           },
         ]);
         mockRegistry.getCompanySettings.mockResolvedValueOnce(null);
         const { app, workerManager } = await createApp({
           actor: {
             type: "board",
             userId: "user-1",
             source: "local_implicit",
             isInstanceAdmin: true,
           },
           plugin: {
             id: pluginId,
             pluginKey: apiRoutes.id,
             status: "ready",
             manifestJson: apiRoutes,
           },
         });

         const res = await request(app)
           .get(`/api/plugins/${pluginId}/api/summary?companyId=${companyId}`);

         expect(res.status).not.toBe(403);
         expect(mockRegistry.getCompanySettings).toHaveBeenCalledWith(pluginId, companyId);
         expect(workerManager.call).toHaveBeenCalled();
       });
     ```

- [ ] **7.2 Run — expect failure** (disabled-row tests get 2xx/dispatch instead of 403):
  ```bash
  pnpm exec vitest run server/src/__tests__/plugin-routes-authz.test.ts server/src/__tests__/plugin-scoped-api-routes.test.ts
  ```

- [ ] **7.3 Implement.** In `server/src/routes/plugins.ts`:

  1. After the `assertPluginBridgeScope` function (lines 707–717) — directly above the Task 6 helpers is fine — add:
     ```ts
       /**
        * Company-scoped bridge invocations additionally require the plugin to
        * be enabled for that company (manifest companyEnablement default +
        * plugin_company_settings). Instance-scoped invocations (no companyId,
        * instance-admin-only per assertPluginBridgeScope) are unaffected.
        */
       async function assertPluginBridgeScopeWithEnablement(
         req: Request,
         pluginRecordId: string,
         companyId: unknown,
       ): Promise<string | undefined> {
         const scopedCompanyId = assertPluginBridgeScope(req, companyId);
         if (scopedCompanyId !== undefined) {
           await enablement.ensurePluginEnabledForCompany(pluginRecordId, scopedCompanyId);
         }
         return scopedCompanyId;
       }
     ```

  2. Replace the four bridge call sites (each appears after a `resolvePlugin` + status check inside its route handler):
     - line 1377: `const companyId = assertPluginBridgeScope(req, body.companyId);` → `const companyId = await assertPluginBridgeScopeWithEnablement(req, plugin.id, body.companyId);`
     - line 1470: same replacement (`body.companyId`).
     - line 1564: `const companyId = assertPluginBridgeScope(req, body?.companyId);` → `const companyId = await assertPluginBridgeScopeWithEnablement(req, plugin.id, body?.companyId);`
     - line 1654: same replacement (`body?.companyId`).

  3. SSE stream (`GET /plugins/:pluginId/bridge/stream/:channel`): after line 1729's `assertCompanyAccess(req, companyId);` add:
     ```ts
         await enablement.ensurePluginEnabledForCompany(plugin.id, companyId);
     ```
     (It must run BEFORE `res.writeHead(200, ...)` at line 1732 so the 403 can still be sent.)

  4. Scoped API mount (`router.use("/plugins/:pluginId/api", ...)`): after line 1818's `assertCompanyAccess(req, companyId);` and before `await enforceScopedApiCheckout(...)` (line 1819) add:
     ```ts
           await enablement.ensurePluginEnabledForCompany(plugin.id, companyId);
     ```
     (This sits inside the route's existing `try` block, whose catch maps `err.status` numbers straight through — a 403 HttpError surfaces as 403.)

- [ ] **7.4 Run — expect pass.**
  ```bash
  pnpm exec vitest run server/src/__tests__/plugin-routes-authz.test.ts server/src/__tests__/plugin-scoped-api-routes.test.ts
  ```

- [ ] **7.5 Commit.**
  ```bash
  git add server/src/routes/plugins.ts server/src/__tests__/plugin-routes-authz.test.ts server/src/__tests__/plugin-scoped-api-routes.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): gate plugin bridge and scoped API routes on company enablement

  bridge/data, bridge/action, data/:key, actions/:key, the bridge SSE
  stream, and plugin-scoped API routes with companyResolution now 403
  (plugin_not_enabled_for_company) for company-disabled plugins;
  instance-scoped bridge calls are unaffected.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 8: Enforcement — agent-tool dispatch and ui-contributions filtering (points 4 & 6-server of 6)

Adapt from `contrib/company-plugin-enablement:server/src/routes/plugins.ts` (tools/execute and ui-contributions hunks) with one deliberate difference on the tool gate: this worktree's `POST /plugins/tools/execute` has TWO dispatch paths — the tool-gateway path for agent actors (`plugins.ts:1032–1059`, wired in production via `app.ts` `{ toolGateway }`) and the direct dispatcher path (`plugins.ts:1061+`). The prior art gated only the dispatcher path via `registeredTool.pluginDbId`; here the gate runs BEFORE both branches by resolving the owning plugin from the namespaced tool name (`"<pluginKey>:<toolName>"`, see `plugin-tool-dispatcher.ts:55/128`).

**Files:**
- Modify: `server/src/routes/plugins.ts` (`POST /plugins/tools/execute` at lines 991–1085; `GET /plugins/ui-contributions` at lines 901–927)
- Test: `server/src/__tests__/plugin-routes-authz.test.ts` (append)

**Interfaces:**
- Consumes: `enablement.ensurePluginEnabledForCompany` (Task 3), `registry.getByKey` (`plugin-registry.ts:76`), `evaluateCompanyEnablement`, `assertCompanyAccess`, `getPluginUiContributionMetadata` (already imported).
- Produces: `GET /plugins/ui-contributions?companyId=<uuid>` — filters out contributions from plugins disabled for that company (asserts company access on the param); without the param the response is unchanged.

**Steps:**

- [ ] **8.1 Write the failing tests.** Append to `server/src/__tests__/plugin-routes-authz.test.ts`. First add one fixture near `catalogPluginRecord` (Task 6): the ui-contributions route additionally requires `entrypoints.ui`/`getPluginUiContributionMetadata`, so give the fixture a UI entrypoint:

  ```ts
  function uiContributionPluginRecord(manifestOverrides: Record<string, unknown> = {}) {
    return catalogPluginRecord({}, {
      entrypoints: { worker: "./dist/worker.js", ui: "dist/ui" },
      ...manifestOverrides,
    });
  }
  ```

  Then append:

  ```ts
  describe.sequential("per-company plugin enablement on tool execution", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    function toolDeps(executeTool: ReturnType<typeof vi.fn>) {
      return {
        toolDispatcher: {
          listToolsForAgent: vi.fn(),
          getTool: vi.fn(() => ({ name: "paperclip.example:search", pluginDbId: pluginId })),
          executeTool,
        },
      };
    }

    function scopeDb() {
      // Three select queues consumed by validateToolRunContextScope:
      // project -> agent -> run (each scoped to companyA).
      return createSelectQueueDb([
        [{ companyId: companyA }],
        [{ companyId: companyA, agentId: agentA }],
        [{ companyId: companyA }],
      ]);
    }

    it("rejects tool execution when the owning plugin is disabled for the run's company", async () => {
      const executeTool = vi.fn();
      mockRegistry.getByKey.mockResolvedValue({ id: pluginId, pluginKey: "paperclip.example" });
      mockRegistry.getById.mockResolvedValue({ id: pluginId, pluginKey: "paperclip.example" });
      mockRegistry.getCompanySettings.mockResolvedValueOnce({ enabled: false });
      const { app } = await createApp(agentActor(), {}, {
        db: scopeDb(),
        toolDeps: toolDeps(executeTool),
      });

      const res = await request(app)
        .post("/api/plugins/tools/execute")
        .send({
          tool: "paperclip.example:search",
          parameters: { q: "test" },
          runContext: { agentId: agentA, runId: runA, companyId: companyA, projectId: projectA },
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("plugin_not_enabled_for_company");
      expect(mockRegistry.getByKey).toHaveBeenCalledWith("paperclip.example");
      expect(mockRegistry.getCompanySettings).toHaveBeenCalledWith(pluginId, companyA);
      expect(executeTool).not.toHaveBeenCalled();
    });

    it("allows tool execution when no company settings row exists for the owning plugin", async () => {
      const executeTool = vi.fn().mockResolvedValue({ content: "ok" });
      mockRegistry.getByKey.mockResolvedValue({ id: pluginId, pluginKey: "paperclip.example" });
      mockRegistry.getById.mockResolvedValue({ id: pluginId, pluginKey: "paperclip.example" });
      mockRegistry.getCompanySettings.mockResolvedValueOnce(null);
      const { app } = await createApp(agentActor(), {}, {
        db: scopeDb(),
        toolDeps: toolDeps(executeTool),
      });

      const res = await request(app)
        .post("/api/plugins/tools/execute")
        .send({
          tool: "paperclip.example:search",
          parameters: { q: "test" },
          runContext: { agentId: agentA, runId: runA, companyId: companyA, projectId: projectA },
        });

      expect(res.status).not.toBe(403);
      expect(executeTool).toHaveBeenCalled();
    });
  });

  describe.sequential("GET /plugins/ui-contributions company filtering", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("filters contributions from plugins disabled for the company", async () => {
      mockRegistry.listByStatus.mockResolvedValueOnce([uiContributionPluginRecord()]);
      mockRegistry.getCompanySettings.mockResolvedValueOnce({ enabled: false });
      const { app } = await createApp(boardActor());

      const res = await request(app).get(`/api/plugins/ui-contributions?companyId=${companyA}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(mockRegistry.getCompanySettings).toHaveBeenCalledWith(pluginId, companyA);
    });

    it("filters default-off plugins with no settings row (manifest-aware)", async () => {
      mockRegistry.listByStatus.mockResolvedValueOnce([
        uiContributionPluginRecord({ companyEnablement: { default: "off" } }),
      ]);
      mockRegistry.getCompanySettings.mockResolvedValueOnce(null);
      const { app } = await createApp(boardActor());

      const res = await request(app).get(`/api/plugins/ui-contributions?companyId=${companyA}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("includes contributions still enabled for the company", async () => {
      mockRegistry.listByStatus.mockResolvedValueOnce([uiContributionPluginRecord()]);
      mockRegistry.getCompanySettings.mockResolvedValueOnce({ enabled: true });
      const { app } = await createApp(boardActor());

      const res = await request(app).get(`/api/plugins/ui-contributions?companyId=${companyA}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        expect.objectContaining({ pluginId, pluginKey: "paperclip.example" }),
      ]);
    });

    it("returns contributions unchanged without a companyId, without settings lookups", async () => {
      mockRegistry.listByStatus.mockResolvedValueOnce([uiContributionPluginRecord()]);
      const { app } = await createApp(boardActor());

      const res = await request(app).get("/api/plugins/ui-contributions");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        expect.objectContaining({ pluginId, pluginKey: "paperclip.example" }),
      ]);
      expect(mockRegistry.getCompanySettings).not.toHaveBeenCalled();
    });

    it("rejects a companyId the actor does not belong to", async () => {
      mockRegistry.listByStatus.mockResolvedValueOnce([uiContributionPluginRecord()]);
      const { app } = await createApp(boardActor({ companyIds: [companyB] }));

      const res = await request(app).get(`/api/plugins/ui-contributions?companyId=${companyA}`);

      expect(res.status).toBe(403);
      expect(mockRegistry.getCompanySettings).not.toHaveBeenCalled();
    });
  });
  ```

  NOTE on the fixture: `getPluginUiContributionMetadata` (`server/src/services/plugin-loader.ts:990`) only requires a non-empty `manifest.ui.slots` or launchers list (it hardcodes `uiEntryFile: "index.js"` and never reads `entrypoints`), so the `catalogPluginRecord` slot declaration already satisfies it; the `entrypoints.ui` override merely keeps the fixture realistic.

- [ ] **8.2 Run — expect failure** (tool tests: 2xx + `executeTool` called; ui-contributions company tests: unfiltered list / no 403):
  ```bash
  pnpm exec vitest run server/src/__tests__/plugin-routes-authz.test.ts
  ```

- [ ] **8.3 Implement the tool gate.** In `server/src/routes/plugins.ts`, inside `POST /plugins/tools/execute`, directly after the scope-validation block (lines 1026–1030):

  ```ts
      assertCompanyAccess(req, runContext.companyId);
      const scopeError = await validateToolRunContextScope(runContext);
      if (scopeError) {
        res.status(403).json({ error: scopeError });
        return;
      }
  ```

  insert (BEFORE the `if (req.actor.type === "agent" && toolGatewayDeps)` branch so both dispatch paths are gated):

  ```ts
      // Per-company plugin enablement: the owning plugin must be enabled for
      // the run's company before ANY dispatch path (tool gateway or direct
      // dispatcher) executes the tool. Tool names are namespaced as
      // "<pluginKey>:<toolName>" (plugin-tool-dispatcher.ts), so resolve the
      // owner by key; unknown keys fall through to the existing 404 handling.
      const namespaceSeparator = tool.indexOf(":");
      const owningPluginKey = namespaceSeparator > 0 ? tool.slice(0, namespaceSeparator) : null;
      if (owningPluginKey) {
        const owningPlugin = await registry.getByKey(owningPluginKey);
        if (owningPlugin) {
          await enablement.ensurePluginEnabledForCompany(owningPlugin.id, runContext.companyId);
        }
      }
  ```

- [ ] **8.4 Implement the ui-contributions filter.** Replace the handler body at lines 901–927:

  ```ts
    router.get("/plugins/ui-contributions", async (req, res) => {
      assertBoardOrgAccess(req);
      const plugins = await registry.listByStatus("ready");

      const contributions: PluginUiContribution[] = plugins
        .map((plugin) => {
          // Safety check: manifestJson should always exist for ready plugins, but guard against null
          const manifest = plugin.manifestJson;
          if (!manifest) return null;

          const uiMetadata = getPluginUiContributionMetadata(manifest);
          if (!uiMetadata) return null;

          return {
            pluginId: plugin.id,
            pluginKey: plugin.pluginKey,
            displayName: manifest.displayName,
            version: plugin.version,
            updatedAt: plugin.updatedAt.toISOString(),
            uiEntryFile: uiMetadata.uiEntryFile,
            slots: uiMetadata.slots,
            launchers: uiMetadata.launchers,
          };
        })
        .filter((item): item is PluginUiContribution => item !== null);
      res.json(contributions);
    });
  ```

  with:

  ```ts
    router.get("/plugins/ui-contributions", async (req, res) => {
      assertBoardOrgAccess(req);
      const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
      if (companyId) assertCompanyAccess(req, companyId);

      const plugins = await registry.listByStatus("ready");

      const mapped = await Promise.all(
        plugins.map(async (plugin) => {
          // Safety check: manifestJson should always exist for ready plugins, but guard against null
          const manifest = plugin.manifestJson;
          if (!manifest) return null;

          const uiMetadata = getPluginUiContributionMetadata(manifest);
          if (!uiMetadata) return null;

          // Per-company filtering: slots from plugins disabled for this
          // company never reach that company's UI (manifest default aware).
          if (companyId) {
            const settings = await registry.getCompanySettings(plugin.id, companyId);
            if (!evaluateCompanyEnablement(manifest, settings)) return null;
          }

          return {
            pluginId: plugin.id,
            pluginKey: plugin.pluginKey,
            displayName: manifest.displayName,
            version: plugin.version,
            updatedAt: plugin.updatedAt.toISOString(),
            uiEntryFile: uiMetadata.uiEntryFile,
            slots: uiMetadata.slots,
            launchers: uiMetadata.launchers,
          };
        }),
      );
      const contributions: PluginUiContribution[] = mapped.filter(
        (item): item is PluginUiContribution => item !== null,
      );
      res.json(contributions);
    });
  ```

  Also update the route's doc comment (the JSDoc directly above, lines 864–899) by appending one line to its description: `Pass ?companyId=<uuid> to additionally filter out contributions from plugins disabled for that company (asserts company access).`

- [ ] **8.5 Run — expect pass**, then the full plugin route suites + typecheck:
  ```bash
  pnpm exec vitest run server/src/__tests__/plugin-routes-authz.test.ts server/src/__tests__/plugin-scoped-api-routes.test.ts && pnpm --filter server typecheck
  ```

- [ ] **8.6 Commit.**
  ```bash
  git add server/src/routes/plugins.ts server/src/__tests__/plugin-routes-authz.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): gate tool execution and ui-contributions on company enablement

  tools/execute resolves the owning plugin from the namespaced tool name
  and 403s before either dispatch path (gateway or dispatcher);
  ui-contributions?companyId filters slots of company-disabled plugins
  server-side.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 9: UI plumbing — api client, queryKeys, company-scoped slot query (enforcement point 6, UI half)

Adapt from `contrib/company-plugin-enablement:ui/src/api/plugins.ts`, `ui/src/lib/queryKeys.ts`, `ui/src/plugins/slots.tsx`, `ui/src/plugins/slots.test.ts`. NOTE this worktree has drifted forward from that branch's base in one helpful way: `SlotFilters` already declares `companyId?: string | null` (`ui/src/plugins/slots.tsx:112`) and callers already pass it (e.g. `CompanySettingsSidebar.tsx:47–52` passes `companyId: selectedCompanyId`) — but the query neither keys on it nor forwards it (`slots.tsx:643–647`). This task closes that gap.

**Files:**
- Modify: `ui/src/api/plugins.ts` (new interface after `PluginLocalFolderSaveInput` ~line 191; `listUiContributions` at line 346; two new methods in the config-endpoints region ~line 430)
- Modify: `ui/src/lib/queryKeys.ts` (`plugins` object, lines 378–389)
- Modify: `ui/src/plugins/slots.tsx` (`usePluginSlots` query, lines 643–647)
- Test: `ui/src/plugins/slots.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  // ui/src/api/plugins.ts
  export interface CompanyPluginCatalogItem {
    pluginId: string;
    pluginKey: string;
    displayName: string;
    version: string;
    description: string | null;
    capabilities: string[];
    enabled: boolean;
    locked: boolean;
    defaultEnabled: boolean;
    hasCompanySettingsPage: boolean;
    settingsRoutePath: string | null;
  }
  pluginsApi.listUiContributions(companyId?: string): Promise<PluginUiContribution[]>
  pluginsApi.listCompanyPluginCatalog(companyId: string): Promise<CompanyPluginCatalogItem[]>
  pluginsApi.setCompanyPluginEnabled(pluginId: string, companyId: string, enabled: boolean): Promise<CompanyPluginCatalogItem>

  // ui/src/lib/queryKeys.ts
  queryKeys.plugins.companyCatalog(companyId: string) // ["plugins", "companies", companyId, "catalog"]
  ```
- Consumes: Task 6/8 endpoints; `api.get`/`api.put` from `ui/src/api/client.ts`.

**Steps:**

- [ ] **9.1 Write the failing tests.** In `ui/src/plugins/slots.test.ts` (adapt from contrib/company-plugin-enablement, verbatim): replace the import block at lines 3–14 with:

  ```ts
  import { createElement } from "react";
  import { flushSync } from "react-dom";
  import { createRoot, type Root } from "react-dom/client";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
  import {
    PluginSlotMount,
    _collectRegisterableExportNamesForTests,
    _resetPluginModuleLoader,
    registerPluginWebComponent,
    usePluginSlots,
    type ResolvedPluginSlot,
  } from "./slots";

  const mockPluginsApi = vi.hoisted(() => ({
    listUiContributions: vi.fn(),
  }));

  vi.mock("../api/plugins", () => ({ pluginsApi: mockPluginsApi }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  async function act(callback: () => void | Promise<void>) {
    let result: void | Promise<void> = undefined;
    flushSync(() => {
      result = callback();
    });
    await result;
  }

  async function flushReact() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  ```

  and append at the end of the file:

  ```ts
  describe("usePluginSlots company filtering", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let captured: any = null;

    function Harness({ companyId }: { companyId?: string | null }) {
      captured = usePluginSlots({ slotTypes: ["toolbarButton"], companyId });
      return null;
    }

    async function renderHook(companyId?: string | null) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(Harness, { companyId }),
          ),
        );
      });
      await flushReact();
      return () => {
        root.unmount();
        container.remove();
      };
    }

    beforeEach(() => {
      captured = null;
      mockPluginsApi.listUiContributions.mockReset();
      mockPluginsApi.listUiContributions.mockResolvedValue([]);
    });

    it("fetches without a companyId when the filter omits it", async () => {
      const cleanup = await renderHook(undefined);
      expect(mockPluginsApi.listUiContributions).toHaveBeenCalledWith(undefined);
      cleanup();
    });

    it("fetches with the companyId when the filter provides it", async () => {
      const cleanup = await renderHook("company-1");
      expect(mockPluginsApi.listUiContributions).toHaveBeenCalledWith("company-1");
      cleanup();
    });

    it("keys the query on companyId so switching companies re-fetches", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(Harness, { companyId: "company-1" }),
          ),
        );
      });
      await flushReact();
      expect(mockPluginsApi.listUiContributions).toHaveBeenCalledTimes(1);
      expect(mockPluginsApi.listUiContributions).toHaveBeenLastCalledWith("company-1");

      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(Harness, { companyId: "company-2" }),
          ),
        );
      });
      await flushReact();
      expect(mockPluginsApi.listUiContributions).toHaveBeenCalledTimes(2);
      expect(mockPluginsApi.listUiContributions).toHaveBeenLastCalledWith("company-2");

      root.unmount();
      container.remove();
    });
  });
  ```

- [ ] **9.2 Run — expect failure.**
  ```bash
  pnpm exec vitest run ui/src/plugins/slots.test.ts
  ```
  Expected: "fetches with the companyId" fails (`listUiContributions` called with no argument) and "keys the query on companyId" fails (1 call, not 2). Pre-existing tests in the file must keep passing.

- [ ] **9.3 Implement `ui/src/api/plugins.ts`.**

  1. After the `PluginLocalFolderSaveInput` interface (ends ~line 192) insert:
     ```ts
     /**
      * A single entry in a company's plugin catalog, returned by
      * `GET /plugins/companies/:companyId/catalog`.
      *
      * Only `ready`, catalog-eligible plugins are included. `enabled` is the
      * effective per-company state (manifest `companyEnablement` default +
      * `plugin_company_settings` row); `locked` marks instance-managed
      * governance plugins (toggling 409s for non-instance-admins);
      * `settingsRoutePath` is set when the plugin contributes a
      * `companySettingsPage` slot, mounted at
      * `/company/settings/${settingsRoutePath}`.
      */
     export interface CompanyPluginCatalogItem {
       pluginId: string;
       pluginKey: string;
       displayName: string;
       version: string;
       description: string | null;
       capabilities: string[];
       enabled: boolean;
       locked: boolean;
       defaultEnabled: boolean;
       hasCompanySettingsPage: boolean;
       settingsRoutePath: string | null;
     }
     ```

  2. Replace `listUiContributions` (lines 346–347):
     ```ts
       listUiContributions: () =>
         api.get<PluginUiContribution[]>("/plugins/ui-contributions"),
     ```
     with:
     ```ts
       listUiContributions: (companyId?: string) =>
         api.get<PluginUiContribution[]>(
           companyId
             ? `/plugins/ui-contributions?companyId=${encodeURIComponent(companyId)}`
             : "/plugins/ui-contributions",
         ),
     ```
     and append to its JSDoc: `When companyId is provided, the server also filters out contributions from plugins disabled for that company (and asserts company access).`

  3. After the local-folders methods (the second `PluginLocalFolderSaveInput` consumer ends ~line 430, before the `// Bridge proxy endpoints` banner) insert:
     ```ts
       // ===========================================================================
       // Company plugin catalog endpoints
       // ===========================================================================

       /**
        * List the company-scoped plugin catalog: every `ready`, catalog-eligible
        * plugin with its effective enablement state, lock state, and (when
        * contributed) company settings route. Used by the CompanyPlugins page.
        */
       listCompanyPluginCatalog: (companyId: string) =>
         api.get<CompanyPluginCatalogItem[]>(`/plugins/companies/${companyId}/catalog`),

       /**
        * Enable or disable a plugin for a specific company. Locked plugins
        * reject non-instance-admin toggles with 409 `plugin_enablement_locked`.
        * Returns the updated catalog item.
        */
       setCompanyPluginEnabled: (pluginId: string, companyId: string, enabled: boolean) =>
         api.put<CompanyPluginCatalogItem>(
           `/plugins/${pluginId}/companies/${companyId}/enablement`,
           { enabled },
         ),
     ```

- [ ] **9.4 Implement `ui/src/lib/queryKeys.ts`.** In the `plugins` object (lines 378–389), after the `localFolders` entry add:
  ```ts
      companyCatalog: (companyId: string) =>
        ["plugins", "companies", companyId, "catalog"] as const,
  ```
  (Deliberately NOT prefixed with the `uiContributions` key; the catalog and contributions invalidate independently, and contributions invalidation uses the `["plugins", "ui-contributions"]` prefix.)

- [ ] **9.5 Implement `ui/src/plugins/slots.tsx`.** Replace (lines 643–647):
  ```ts
    const { data, isLoading: isQueryLoading, error } = useQuery({
      queryKey: queryKeys.plugins.uiContributions,
      queryFn: () => pluginsApi.listUiContributions(),
      enabled: queryEnabled,
    });
  ```
  with:
  ```ts
    const { data, isLoading: isQueryLoading, error } = useQuery({
      queryKey: [...queryKeys.plugins.uiContributions, filters.companyId ?? null],
      queryFn: () => pluginsApi.listUiContributions(filters.companyId ?? undefined),
      enabled: queryEnabled,
    });
  ```

- [ ] **9.6 Run — expect pass**, plus UI typecheck:
  ```bash
  pnpm exec vitest run ui/src/plugins/slots.test.ts && pnpm --filter ui typecheck
  ```

- [ ] **9.7 Commit.**
  ```bash
  git add ui/src/api/plugins.ts ui/src/lib/queryKeys.ts ui/src/plugins/slots.tsx ui/src/plugins/slots.test.ts
  git commit -m "$(cat <<'EOF'
  feat(ui): company-scoped plugin slot query and catalog api client

  usePluginSlots keys and forwards the (already-declared) companyId filter
  so disabled plugins' slots vanish per company; adds catalog/enablement
  api methods and the companyCatalog query key.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 10: Company settings "Plugins" page, route, and sidebar entry

Adapt from `contrib/company-plugin-enablement:ui/src/pages/CompanyPlugins.tsx` and `CompanyPlugins.test.tsx`, with two deltas: `locked` plugins render as non-interactive "Managed by instance" rows (spec §4.2), and a 403 on catalog load is treated as a navigation miss redirecting to the company settings root (spec §6).

**Files:**
- Create: `ui/src/pages/CompanyPlugins.tsx`
- Modify: `ui/src/App.tsx` (import after `CompanyInvites` import at line 62; route after the invites route at line 109)
- Modify: `ui/src/components/CompanySettingsSidebar.tsx` (one nav item between lines 134 and 135)
- Test (create): `ui/src/pages/CompanyPlugins.test.tsx`

**Interfaces:**
- Consumes: `pluginsApi.listCompanyPluginCatalog` / `setCompanyPluginEnabled` and `CompanyPluginCatalogItem` (Task 9); `queryKeys.plugins.companyCatalog` / `queryKeys.plugins.uiContributions`; `useCompany` (`ui/src/context/CompanyContext` — fields `selectedCompany`, `selectedCompanyId`); `useBreadcrumbs` (`ui/src/context/BreadcrumbContext`); `useToastActions` (`ui/src/context/ToastContext` — `pushToast({ title, body, tone })`); `Link`, `Navigate` (`ui/src/lib/router`); `ApiError` (`ui/src/api/client`); `Button`, `Badge`, `Card`, `CardContent` (`ui/src/components/ui/*`); `cn` (`ui/src/lib/utils`); `Puzzle`, `Settings`, `Lock` icons (`lucide-react`).
- Produces: route `/company/settings/plugins` rendering `<CompanyPlugins />`; sidebar entry "Plugins".

**Steps:**

- [ ] **10.1 Write the failing tests.** Create `ui/src/pages/CompanyPlugins.test.tsx`:

  ```tsx
  // @vitest-environment jsdom

  import { act } from "react";
  import { createRoot } from "react-dom/client";
  import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
  import { CompanyPlugins } from "./CompanyPlugins";
  import { ApiError } from "@/api/client";
  import type { CompanyPluginCatalogItem } from "@/api/plugins";
  import { queryKeys } from "@/lib/queryKeys";

  const listCompanyPluginCatalogMock = vi.hoisted(() => vi.fn());
  const setCompanyPluginEnabledMock = vi.hoisted(() => vi.fn());
  const pushToastMock = vi.hoisted(() => vi.fn());
  const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

  vi.mock("@/api/plugins", () => ({
    pluginsApi: {
      listCompanyPluginCatalog: (companyId: string) => listCompanyPluginCatalogMock(companyId),
      setCompanyPluginEnabled: (pluginId: string, companyId: string, enabled: boolean) =>
        setCompanyPluginEnabledMock(pluginId, companyId, enabled),
    },
  }));

  vi.mock("@/context/CompanyContext", () => ({
    useCompany: () => ({
      selectedCompanyId: "company-1",
      selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
    }),
  }));

  vi.mock("@/context/BreadcrumbContext", () => ({
    useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
  }));

  vi.mock("@/context/ToastContext", () => ({
    useToastActions: () => ({ pushToast: pushToastMock }),
  }));

  vi.mock("@/lib/router", () => ({
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
    Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  async function flushReact() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  async function renderPage() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyPlugins />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return { container, root, queryClient };
  }

  function catalogItem(overrides: Partial<CompanyPluginCatalogItem> = {}): CompanyPluginCatalogItem {
    return {
      pluginId: "plugin-1",
      pluginKey: "linear-sync",
      displayName: "Linear Sync",
      version: "1.2.0",
      description: "Sync issues with Linear.",
      capabilities: ["issues.read"],
      enabled: true,
      locked: false,
      defaultEnabled: true,
      hasCompanySettingsPage: false,
      settingsRoutePath: null,
      ...overrides,
    };
  }

  describe("CompanyPlugins", () => {
    afterEach(() => {
      document.body.innerHTML = "";
      vi.clearAllMocks();
    });

    beforeEach(() => {
      setCompanyPluginEnabledMock.mockResolvedValue(catalogItem());
    });

    it("renders one row per catalog item with displayName and version", async () => {
      listCompanyPluginCatalogMock.mockResolvedValue([
        catalogItem({ pluginId: "plugin-1", displayName: "Linear Sync", version: "1.2.0" }),
        catalogItem({ pluginId: "plugin-2", displayName: "Slack Bridge", version: "0.4.1" }),
      ]);

      const { container, root } = await renderPage();

      expect(listCompanyPluginCatalogMock).toHaveBeenCalledWith("company-1");
      expect(container.textContent).toContain("Linear Sync");
      expect(container.textContent).toContain("1.2.0");
      expect(container.textContent).toContain("Slack Bridge");
      expect(container.textContent).toContain("0.4.1");
      // Capability summary (spec §4.5)
      expect(container.textContent).toContain("issues.read");

      await act(async () => {
        root.unmount();
      });
    });

    it("toggles a plugin's enablement and refreshes catalog + ui contributions", async () => {
      const disabled = catalogItem({ pluginId: "plugin-1", displayName: "Linear Sync", enabled: false });
      listCompanyPluginCatalogMock.mockResolvedValueOnce([disabled]);
      listCompanyPluginCatalogMock.mockResolvedValueOnce([{ ...disabled, enabled: true }]);
      setCompanyPluginEnabledMock.mockResolvedValue({ ...disabled, enabled: true });

      const { container, root, queryClient } = await renderPage();
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      const enableButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Enable",
      );
      expect(enableButton).toBeTruthy();

      await act(async () => {
        enableButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
      await flushReact();

      expect(setCompanyPluginEnabledMock).toHaveBeenCalledWith("plugin-1", "company-1", true);
      expect(listCompanyPluginCatalogMock).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("Disable");
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: queryKeys.plugins.companyCatalog("company-1") }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: queryKeys.plugins.uiContributions }),
      );

      await act(async () => {
        root.unmount();
      });
    });

    it("renders locked plugins as non-interactive, managed-by-instance rows", async () => {
      listCompanyPluginCatalogMock.mockResolvedValue([
        catalogItem({
          pluginId: "plugin-billing",
          displayName: "Billing",
          enabled: true,
          locked: true,
        }),
      ]);

      const { container, root } = await renderPage();

      expect(container.textContent).toContain("Managed by instance");
      const buttons = Array.from(container.querySelectorAll("button")).map(
        (button) => button.textContent?.trim(),
      );
      expect(buttons).not.toContain("Disable");
      expect(buttons).not.toContain("Enable");

      await act(async () => {
        root.unmount();
      });
    });

    it("renders a Settings link only for enabled plugins with a settingsRoutePath", async () => {
      listCompanyPluginCatalogMock.mockResolvedValue([
        catalogItem({
          pluginId: "plugin-1",
          displayName: "Linear Sync",
          enabled: true,
          hasCompanySettingsPage: true,
          settingsRoutePath: "linear-sync",
        }),
        catalogItem({
          pluginId: "plugin-2",
          displayName: "Slack Bridge",
          enabled: false,
          hasCompanySettingsPage: true,
          settingsRoutePath: "slack-bridge",
        }),
        catalogItem({
          pluginId: "plugin-3",
          displayName: "No Settings Plugin",
          enabled: true,
        }),
      ]);

      const { container, root } = await renderPage();

      const links = Array.from(container.querySelectorAll("a"));
      expect(links.some((link) => link.getAttribute("href") === "/company/settings/linear-sync")).toBe(true);
      expect(links.some((link) => link.getAttribute("href") === "/company/settings/slack-bridge")).toBe(false);
      expect(links.length).toBe(1);

      await act(async () => {
        root.unmount();
      });
    });

    it("treats a 403 catalog response as a navigation miss (redirect to settings root)", async () => {
      listCompanyPluginCatalogMock.mockRejectedValue(
        new ApiError("Forbidden", 403, { code: "surface_not_exposed" }),
      );

      const { container, root } = await renderPage();

      const navigate = container.querySelector('[data-testid="navigate"]');
      expect(navigate).not.toBeNull();
      expect(navigate?.getAttribute("data-to")).toBe("/company/settings");

      await act(async () => {
        root.unmount();
      });
    });

    it("renders an empty state mentioning that instance admins install plugins", async () => {
      listCompanyPluginCatalogMock.mockResolvedValue([]);

      const { container, root } = await renderPage();

      expect(container.textContent).toMatch(/instance admin/i);
      expect(container.textContent).toMatch(/install/i);

      await act(async () => {
        root.unmount();
      });
    });
  });
  ```

- [ ] **10.2 Run — expect failure** (module `./CompanyPlugins` does not exist):
  ```bash
  pnpm exec vitest run ui/src/pages/CompanyPlugins.test.tsx
  ```

- [ ] **10.3 Implement the page.** Create `ui/src/pages/CompanyPlugins.tsx` (adapted from contrib/company-plugin-enablement:ui/src/pages/CompanyPlugins.tsx; deltas: locked rows, 403 redirect):

  ```tsx
  import { useEffect } from "react";
  import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
  import { Lock, Puzzle, Settings as SettingsIcon } from "lucide-react";
  import { ApiError } from "@/api/client";
  import { pluginsApi, type CompanyPluginCatalogItem } from "@/api/plugins";
  import { Button } from "@/components/ui/button";
  import { Badge } from "@/components/ui/badge";
  import { Card, CardContent } from "@/components/ui/card";
  import { useBreadcrumbs } from "@/context/BreadcrumbContext";
  import { useCompany } from "@/context/CompanyContext";
  import { useToastActions } from "@/context/ToastContext";
  import { Link, Navigate } from "@/lib/router";
  import { queryKeys } from "@/lib/queryKeys";
  import { cn } from "@/lib/utils";

  /**
   * Company-settings "Plugins" page (settings surface `company.plugins`).
   *
   * Lists every `ready`, catalog-eligible plugin with its per-company
   * enablement state and lets holders of `plugins:manage` (company
   * owners/admins implicitly) turn plugins on or off for this company.
   * Plugins are installed/removed by instance admins (see PluginManager);
   * this page only toggles the company-scoped switch.
   *
   * Locked plugins (`manifest.companyEnablement.locked`) render as
   * non-interactive "Managed by instance" rows.
   *
   * A 403 from the catalog (hidden surface, revoked access) is a navigation
   * miss, not a crash: redirect to the company settings root.
   *
   * @see server/src/routes/plugins.ts — `GET /plugins/companies/:companyId/catalog`
   *   and `PUT /plugins/:pluginId/companies/:companyId/enablement`.
   */
  export function CompanyPlugins() {
    const { selectedCompany, selectedCompanyId } = useCompany();
    const { setBreadcrumbs } = useBreadcrumbs();
    const { pushToast } = useToastActions();
    const queryClient = useQueryClient();

    useEffect(() => {
      setBreadcrumbs([
        { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
        { label: "Settings", href: "/company/settings" },
        { label: "Plugins" },
      ]);
    }, [selectedCompany?.name, setBreadcrumbs]);

    const catalogQueryKey = queryKeys.plugins.companyCatalog(selectedCompanyId ?? "");
    const {
      data: catalog,
      isLoading,
      error,
    } = useQuery({
      queryKey: catalogQueryKey,
      queryFn: () => pluginsApi.listCompanyPluginCatalog(selectedCompanyId!),
      enabled: Boolean(selectedCompanyId),
    });

    const toggleMutation = useMutation({
      mutationFn: (item: CompanyPluginCatalogItem) =>
        pluginsApi.setCompanyPluginEnabled(item.pluginId, selectedCompanyId!, !item.enabled),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: catalogQueryKey });
        // Prefix match: also covers ui-contributions queries suffixed with a
        // companyId (see ui/src/plugins/slots.tsx). Without this, toggling a
        // plugin off leaves its UI contributions visible until react-query's
        // next background refetch.
        queryClient.invalidateQueries({ queryKey: queryKeys.plugins.uiContributions });
      },
      onError: (err: Error) => {
        pushToast({ title: "Failed to update plugin", body: err.message, tone: "error" });
      },
    });

    if (!selectedCompanyId) {
      return <div className="text-sm text-muted-foreground">Select a company to manage plugins.</div>;
    }

    if (isLoading) {
      return <div className="text-sm text-muted-foreground">Loading plugins…</div>;
    }

    if (error) {
      // 403 (hidden surface / revoked access) is a navigation miss, not a crash.
      if (error instanceof ApiError && error.status === 403) {
        return <Navigate to="/company/settings" replace />;
      }
      return <div className="text-sm text-destructive">Failed to load plugins.</div>;
    }

    const items = catalog ?? [];

    return (
      <div className="max-w-5xl space-y-8">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Puzzle className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Plugins</h1>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Turn installed plugins on or off for this company. Disabling a plugin here
            hides its contributions from this company without uninstalling it.
          </p>
        </div>

        {items.length === 0 ? (
          <Card className="bg-muted/30">
            <CardContent className="flex flex-col items-center justify-center py-10 text-center">
              <Puzzle className="mb-4 h-10 w-10 text-muted-foreground" />
              <p className="text-sm font-medium">No plugins installed</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                Instance admins install plugins from instance settings. Once a plugin
                is installed, it will appear here so you can enable it for this company.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="block py-0">
            <ul className="divide-y">
              {items.map((item) => {
                const pending =
                  toggleMutation.isPending && toggleMutation.variables?.pluginId === item.pluginId;
                return (
                  <li key={item.pluginId}>
                    <div className="flex items-start gap-4 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.displayName}</span>
                          <Badge variant="outline">v{item.version}</Badge>
                          <Badge
                            variant={item.enabled ? "default" : "secondary"}
                            className={cn(item.enabled && "bg-green-600 hover:bg-green-700")}
                          >
                            {item.enabled ? "Enabled" : "Disabled"}
                          </Badge>
                          {item.locked ? (
                            <Badge variant="outline" className="gap-1">
                              <Lock className="h-3 w-3" />
                              Managed by instance
                            </Badge>
                          ) : null}
                        </div>
                        {item.description ? (
                          <p className="mt-1 truncate text-sm text-muted-foreground" title={item.description}>
                            {item.description}
                          </p>
                        ) : null}
                        {item.capabilities.length > 0 ? (
                          <p
                            className="mt-1 truncate text-xs text-muted-foreground"
                            title={item.capabilities.join(", ")}
                          >
                            Capabilities: {item.capabilities.join(", ")}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {item.enabled && item.settingsRoutePath ? (
                          <Button variant="outline" size="sm" asChild>
                            <Link to={`/company/settings/${item.settingsRoutePath}`}>
                              <SettingsIcon className="h-4 w-4" />
                              Settings
                            </Link>
                          </Button>
                        ) : null}
                        {item.locked ? null : (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={pending}
                            onClick={() => toggleMutation.mutate(item)}
                          >
                            {pending ? "Working…" : item.enabled ? "Disable" : "Enable"}
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    );
  }
  ```

- [ ] **10.4 Wire route and sidebar.**

  1. `ui/src/App.tsx` — after `import { CompanyInvites } from "./pages/CompanyInvites";` (line 62) add:
     ```tsx
     import { CompanyPlugins } from "./pages/CompanyPlugins";
     ```
     and after `<Route path="company/settings/invites" element={<CompanyInvites />} />` (line 109) add:
     ```tsx
           <Route path="company/settings/plugins" element={<CompanyPlugins />} />
     ```

  2. `ui/src/components/CompanySettingsSidebar.tsx` — between the Invites and Secrets items (lines 134–135) insert:
     ```tsx
             <SidebarNavItem to="/company/settings/plugins" label="Plugins" icon={Puzzle} end />
     ```
     (`Puzzle` is already imported at line 11. PR-1 later re-renders this section from `capabilities.exposedSurfaces`; this static entry is the PR-2 baseline, matching how Invites/Secrets render today.)

- [ ] **10.5 Run — expect pass**, plus the sidebar regression test and UI typecheck:
  ```bash
  pnpm exec vitest run ui/src/pages/CompanyPlugins.test.tsx ui/src/components/CompanySettingsSidebar.test.tsx && pnpm --filter ui typecheck
  ```
  If `CompanySettingsSidebar.test.tsx` asserts an exact nav-item list, add the "Plugins" entry to its expectation (intended change).

- [ ] **10.6 Capture UI screenshots for the PR.** Any PR touching UI surfaces needs screenshots committed/attached (repo convention). Run the app (or Storybook if faster), screenshot the new `/company/settings/plugins` page in populated, empty, and locked-row states, and stage them wherever this repo's previous UI PRs put them (check the most recent UI PR for the location/attachment convention).

- [ ] **10.7 Commit.**
  ```bash
  git add ui/src/pages/CompanyPlugins.tsx ui/src/pages/CompanyPlugins.test.tsx ui/src/App.tsx ui/src/components/CompanySettingsSidebar.tsx
  git add -u ui/src/components/CompanySettingsSidebar.test.tsx
  git commit -m "$(cat <<'EOF'
  feat(ui): company plugin catalog settings page

  /company/settings/plugins lists the per-company catalog with
  enable/disable toggles (plugins:manage holders), locked plugins render
  as non-interactive managed-by-instance rows, and 403s redirect to the
  settings root as navigation misses.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 11: Full verification and coverage self-check

**Files:** none created/modified unless a failure shows a real gap (fix in the task that owns the file, amend that task's commit style with a follow-up `fix:` commit).

**Steps:**

- [ ] **11.1 Run every suite this plan created or touched, in one pass:**
  ```bash
  pnpm exec vitest run \
    packages/shared/src/validators/plugin.test.ts \
    server/src/services/company-member-roles.test.ts \
    server/src/services/plugin-company-enablement.test.ts \
    server/src/services/plugin-event-bus.test.ts \
    server/src/__tests__/plugin-host-services-company-gate.test.ts \
    server/src/__tests__/plugin-routes-authz.test.ts \
    server/src/__tests__/plugin-scoped-api-routes.test.ts \
    server/src/__tests__/plugin-orchestration-apis.test.ts \
    server/src/__tests__/plugin-access-authorization-host-services.test.ts \
    server/src/__tests__/invite-join-grants.test.ts \
    server/src/__tests__/access-service.test.ts \
    ui/src/plugins/slots.test.ts \
    ui/src/pages/CompanyPlugins.test.tsx \
    ui/src/components/CompanySettingsSidebar.test.tsx
  ```
  Expected: all pass (embedded-postgres suites may skip on unsupported hosts).

- [ ] **11.2 Typecheck all three packages:**
  ```bash
  pnpm --filter @paperclipai/shared typecheck && pnpm --filter server typecheck && pnpm --filter ui typecheck
  ```

- [ ] **11.3 Spec §7 PR-2 coverage audit** — confirm each row maps to a green test:
  - enablement-helper unit tests (default on/off × row states) → `plugin-company-enablement.test.ts` (Task 3)
  - authz tests: `plugins:manage` → Task 6 tests 6/7; viewer denied → Task 6 test 8; locked 409 → Task 6 test 9 (+ admin override test 10)
  - enforcement, one per gate point (6): host-services → Task 5; bridge data/actions (+SSE) → Task 7; event-bus → Task 4; agent-tool dispatch → Task 8; scoped API routes with companyResolution → Task 7 (scoped-api tests); ui-contributions → Task 8 (server) + Task 9 (query keying)
  - slot-filtering UI test → `slots.test.ts` "usePluginSlots company filtering" (Task 9)
  - §6 error rows: typed 403 `plugin_not_enabled_for_company` asserted in Tasks 3/5/7/8; 409 `plugin_enablement_locked` in Task 6; UI navigation-miss redirect in Task 10.

- [ ] **11.4 Grep for leftovers** (must all return nothing):
  ```bash
  grep -rn "TODO\|FIXME\|PLACEHOLDER" server/src/services/plugin-company-enablement.ts ui/src/pages/CompanyPlugins.tsx
  git status --porcelain   # no unstaged stragglers, and NO pnpm-lock.yaml changes
  ```

- [ ] **11.5 Done.** Do not merge/PR from this plan; hand back to the coordinating session (branch is stacked on PR-1 per Global Constraints).
