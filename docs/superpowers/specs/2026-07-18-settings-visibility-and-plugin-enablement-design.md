# Settings Visibility, Per-Company Plugin Enablement, and Company Standing — Design

Date: 2026-07-18
Status: Approved design, pending implementation plan
Scope: Three independent, individually upstreamable core PRs (PR-1, PR-2, PR-3). The billing plugin that consumes them is specified separately in `2026-07-18-billing-plugin-design.md`.

## 1. Problem

On a multi-tenant (shared) paperclip instance, every user currently sees roughly the same settings surface as a self-hosted operator:

- `CompanySettingsSidebar.tsx` renders the entire "Instance settings" section to every member — there is no `isInstanceAdmin` gate in the nav.
- Any active company member can `GET /instance/settings/*` (writes are already instance-admin-only via `assertCanManageInstanceSettings`).
- There is no way for an instance admin to decide which settings surfaces companies may use.
- `plugin_company_settings.enabled` exists in the schema but is not enforced: plugin enablement is effectively instance-global.
- There is no generic mechanism for a plugin to stop a company from starting new work (needed by billing, and useful for compliance/quota plugins).

Target model: **the instance admin sees everything (self-hosted parity); company owners see only the company-scoped subset the instance admin exposed; instance-scoped settings (including sandboxing/execution policy) are structurally invisible to non-admins; the instance admin installs plugins, and company owners enable them per company.**

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| Contribution strategy | Upstream-first primitives: PR-1/2/3 are generic upstream PRs against `paperclipai/paperclip`; fork carries them immediately |
| Relationship to prior art | Fresh design. Where it converges with the existing `contrib/company-plugin-enablement` branch (PR D) or the 2026-07-13 §5 design, implementation may cherry-pick/reuse that code; the old branch and the 2026-07-14 remove-budget-monetization spec are otherwise not inputs |
| Visibility granularity | One instance-wide policy (no per-company overrides in v1) |
| Enforcement philosophy | Server-side first; UI renders from a server-delivered capabilities payload |

## 3. PR-1 — Settings-surface policy

### 3.1 Surface taxonomy

New shared constants in `packages/shared/src/constants.ts`:

```ts
export const COMPANY_SETTINGS_SURFACES = [
  "company.general",
  "company.members",
  "company.invites",
  "company.secrets",
  "company.plugins",     // the plugin catalog/toggle page introduced by PR-2.
                         // Gates the catalog ONLY: companySettingsPages of already-enabled
                         // plugins render regardless (a hidden catalog must not hide e.g. Billing).
] as const;

export const INSTANCE_SETTINGS_SURFACES = [
  "instance.general",     // includes executionMode / sandbox policy
  "instance.environments",
  "instance.access",
  "instance.heartbeats",
  "instance.experimental",
  "instance.plugins",     // install/upgrade/instance config
  "instance.adapters",
] as const;
```

Rules:

- Instance-scoped surfaces are **never exposable** to non-admins. They do not appear in the policy at all. Sandboxing (`executionMode`) lives in `instance.general`, so it is structurally invisible to company owners — not a policy choice that could be misconfigured.
- Company-scoped surfaces are exposable per policy. `company.cloud-upstream` remains gated by its existing experimental flag and is out of scope here.
- Per-user pages (`profile`) are always visible and not part of the taxonomy.

### 3.2 Policy storage

New `visibility` section in `instance_settings` (beside `general` / `experimental`):

```ts
interface InstanceVisibilitySettings {
  companySurfaces: CompanySettingsSurface[]; // default: ALL company surfaces
}
```

- Type in `packages/shared/src/types/instance.ts`, Zod validator in `packages/shared/src/validators/instance.ts`.
- Default = all company surfaces exposed → **zero behavior change for self-hosters**.
- `GET/PATCH /instance/settings/visibility`; PATCH gated by `assertCanManageInstanceSettings`.
- Admin UI: a "Company settings visibility" card (checkbox per company surface) on the Instance Access page (`InstanceAccess.tsx`), which is the natural "who may do what" home.

### 3.3 Capabilities payload

Extend the existing `GET /cli-auth/me` response (`CurrentBoardAccess`) with:

```ts
capabilities: {
  exposedSurfaces: CompanySettingsSurface[]; // full list for instance admins
  features: PublicFeatureFlags;              // safe, derived subset of experimental flags the UI needs
  companyStandings: Record<CompanyId, EffectiveStanding>; // added by PR-3
}
```

- `features` exists so the UI stops reading `/instance/settings/experimental` directly. It is the explicit, reviewed allowlist of flags the frontend branches on (`enableEnvironments`, `enableCases`, `enableCloudSync`, `enableDecisions`, `enableBuiltInAgents`, `managedExperience`, …). Anything not on the allowlist stays server-private.
- With that in place, `GET /instance/settings`, `/general`, `/experimental` change from `assertBoardOrgAccess` to `assertCanManageInstanceSettings` (instance-admin-only reads). This closes the read hole and is the one deliberate behavior change; the UI migration to `capabilities.features` ships in the same PR.

### 3.4 Enforcement

- Server: `assertSurfaceExposed(surface)` helper in `server/src/routes/authz.ts`, applied to the company-scoped route groups backing each surface (members/invites management, secrets, plugin catalog). Instance admins and `local_trusted` implicit actors bypass. Non-admin actors on a hidden surface get 403 `surface_not_exposed`.
- UI: `CompanySettingsSidebar.tsx` and `access/CompanySettingsNav.tsx` render company entries from `capabilities.exposedSurfaces`, and render the Instance settings section only when `isInstanceAdmin`.
- `local_trusted` mode: implicit actor is instance admin → sees everything, exactly as today.

## 4. PR-2 — Per-company plugin enablement

### 4.1 Model

Two AND-ed switches, both required for a plugin to act for a company:

1. Instance switch (exists): `plugins.status === "ready"` — instance admin installs/upgrades/disables instance-wide.
2. Company switch (schema exists, dormant): `plugin_company_settings.enabled` — company decides for itself.

### 4.2 Manifest addition

```ts
companyEnablement?: {
  default: "on" | "off"; // absent ⇒ "on" (today's behavior; existing plugins unaffected)
  locked?: boolean;       // true ⇒ companies cannot toggle; state is manifest default, only
                          // instance admin may override per company (governance plugins, e.g. billing)
}
```

- `default: "off"` enables opt-in plugins (no row ⇒ disabled).
- `default: "on"`, no row ⇒ enabled (backward compatible).
- `locked: true` renders as a non-interactive "Managed by instance" entry in the company catalog.
- Sandbox-provider/credential-broker infrastructure plugins remain excluded from the catalog via their existing categories.

### 4.3 Routes and authz

- `GET /plugins/companies/:companyId/catalog` — installed + ready + catalog-eligible plugins with `{ enabled, locked, defaultEnabled, hasCompanySettingsPage }`.
- `PUT /plugins/:pluginId/companies/:companyId/enablement` — `{ enabled }`; 409 for `locked` plugins.
- Authz: new permission key `plugins:manage` in `PERMISSION_KEYS`, implicitly held by company `owner`/`admin` memberships, grantable to other principals via `principal_permission_grants`. Catalog read requires active membership + `company.plugins` surface exposure (PR-1); toggle requires `plugins:manage`.

### 4.4 Enforcement points

A single helper (`plugin-company-enablement.ts`): `isPluginEnabledForCompany(pluginId, companyId)` consulting manifest default + `plugin_company_settings`, applied at:

1. Host-services company resolution (plugin acting on a company),
2. Bridge data/actions calls,
3. Event-bus delivery of company-scoped events,
4. Agent-tool dispatch,
5. Plugin-scoped API routes with `companyResolution`,
6. `ui-contributions` (slots from disabled plugins never reach that company's UI).

### 4.5 UI

"Plugins" page in company settings (surface `company.plugins`): catalog list with toggle, capability summary, and a link into the plugin's `companySettingsPage` when enabled.

### 4.6 Reuse note

This deliberately converges with the `contrib/company-plugin-enablement` branch. At implementation time, diff against it and cherry-pick what matches (enforcement wiring and authz tests looked directly reusable). Designed deltas vs that branch: manifest `companyEnablement.default` (enables opt-in plugins), `locked`, the `plugins:manage` permission key, and the PR-1 surface gate on the catalog page.

## 5. PR-3 — Company-standing gate

The one generic hook a billing (or compliance/quota) plugin needs: declare that a company may not start new work, without core knowing anything about money.

### 5.1 Data model

New core table `company_standing`:

| Column | Type | Notes |
| --- | --- | --- |
| `company_id` | fk companies | PK part |
| `plugin_id` | fk plugins | PK part; row-per-plugin so plugins cannot clobber each other |
| `status` | enum `active` \| `grace` \| `blocked` | |
| `reason` | text | short machine code, e.g. `subscription_lapsed` |
| `message` | text | human text shown in banners/errors |
| `action_url` | text nullable | deep link, e.g. the billing page |
| `updated_at` | timestamptz | |

Effective standing per company = most severe row (`blocked` > `grace` > `active`); no rows ⇒ `active`.

### 5.2 Capability + host service

- New capability `company.standing.write` in `PLUGIN_CAPABILITIES` (write group, flagged sensitive on the install screen).
- Host services: `ctx.companies.setStanding(companyId, { status, reason, message, actionUrl })` and `ctx.companies.clearStanding(companyId)`. Rows are always scoped to the calling plugin.
- Cleanup: uninstalling a plugin, instance-disabling it, or company-disabling it deletes that plugin's standing rows — a removed governance plugin can never leave companies stranded.

### 5.3 Enforcement

- One check in the run-start gate, alongside the existing budget hard-stop (`getInvocationBlock` call site in heartbeat invocation): effective `blocked` ⇒ refuse new agent runs/heartbeat work with typed error `company_blocked` carrying `message` and `actionUrl`.
- `grace` never blocks; it exists so UIs can warn.
- Reads, settings, and all company pages stay fully accessible (block runs, keep read access).
- Fail-safe: anything unknown or unwritten = `active`. Only an explicit persisted `blocked` row stops work; a crashed plugin cannot lock companies out.

### 5.4 UI

- Effective standings ride the PR-1 capabilities payload (`companyStandings`).
- Layout-level banner per selected company: `grace` → warning + action link; `blocked` → error banner; run-start affordances surface the `company_blocked` message with the action link.
- Company switcher shows standing badges so an owner with many companies cannot miss a lapsed one.

## 6. Error handling

- 403 `surface_not_exposed` (PR-1) and `plugin_not_enabled_for_company` (PR-2) are typed errors; the UI treats them as navigation misses (redirect to company settings root), not crashes.
- 409 on toggling a `locked` plugin.
- `company_blocked` (PR-3) is a typed, user-presentable error; agents receiving it mark work blocked rather than failed-retryable.
- Capabilities payload failures degrade closed for nav (hide what is unknown) but never block the already-loaded page.

## 7. Testing

- **PR-1:** taxonomy/validator unit tests; route authz tests (instance-settings reads 403 for non-admins; `assertSurfaceExposed` per surface × role matrix); UI tests for sidebar/nav from capabilities (admin vs owner vs member); regression: `local_trusted` sees everything; migration test for the UI's switch to `capabilities.features`.
- **PR-2:** enablement-helper unit tests (default on/off × row states); authz tests for catalog/enablement routes (`plugins:manage`, viewer denied, locked 409); one enforcement test per gate point (6); slot-filtering UI test.
- **PR-3:** severity-merge unit tests; run-start gate tests (blocked ⇒ typed error; grace ⇒ runs proceed); cleanup-on-uninstall/disable tests; banner + switcher badge rendering tests.

## 8. Sequencing and delivery

- Three branches in slice order PR-1 → PR-2 → PR-3; each is independently upstreamable and lands in the fork immediately.
- PR-2/PR-3 touch PR-1 only via the capabilities payload → parallel worktrees, stacked per the `rebase --onto` slice flow; migration renumbering rules apply to PR-3's table.
- The billing plugin (separate spec) rides all three in the fork while upstream review proceeds.
