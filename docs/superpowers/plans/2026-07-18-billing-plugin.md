# paperclip-plugin-billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `packages/plugins/plugin-billing` — a fully self-contained billing plugin for multi-tenant paperclip instances per `docs/superpowers/specs/2026-07-18-billing-plugin-design.md`: flat monthly fee per company, configurable trial, provider-pluggable checkout with a fully functional HMAC-signed stub provider, a pure exhaustively-tested subscription state machine, an append-only ledger, a daily reconciliation sweep, company Billing page + instance admin page + stub checkout simulator, and enforcement exclusively via the PR-3 `company.standing.write` primitive. Zero core billing knowledge; zero external infrastructure.

**Architecture:** One plugin package mirroring `packages/plugins/plugin-llm-wiki` (manifest + out-of-process worker + esbuild-bundled UI + namespace SQL migrations + vitest tests). Inside the worker, a strict layering: pure domain core (`state-machine.ts`, `creation.ts` — no I/O), a `BillingStore` port with a SQL adapter (`ctx.db`, namespace `plugin_billing_d8ffbbf605`) and an in-memory adapter for tests, a `BillingProvider` port (spec §5 verbatim) with the stub implementation, and thin edges (webhook handler, sweep job, `BillingService` consumed by both the UI bridge handlers and the manifest `apiRoutes`). Every state mutation is caused by exactly one `billing_events` ledger row; the sweep re-derives everything (rowless companies, clock transitions, standing reconciliation, unapplied-ledger replay, deleted-company provider cancels).

**Tech Stack:** TypeScript strict, `@paperclipai/plugin-sdk` (worker) + `@paperclipai/plugin-sdk/ui` (React bridge components), `@paperclipai/plugin-sdk/testing` harness, esbuild via `createPluginBundlerPresets`, vitest, pnpm workspace. No new dependencies beyond what `plugin-llm-wiki` already uses.

## Global Constraints

- **Worktree**: All work happens in `/Users/jannesstubbemann/repos/paperclip/wt-specs-billing-visibility` on branch `spec/billing-and-settings-visibility`. Subagents must `cd` there as Step 0 (subagents do not inherit the worktree cwd).
- **Dependency on PR-1/2/3 (settings-visibility spec)** — depend on these EXACT names; they may not exist in this branch yet, in which case the compatibility shims below keep the plugin compiling and tested:
  - PR-2 manifest field: `companyEnablement: { default: "on", locked: true }`. `PaperclipPluginManifestV1` does not have this field until PR-2 lands → the manifest object declares it and casts (Task 2).
  - PR-3 capability `"company.standing.write"`. Not in `PLUGIN_CAPABILITIES` (`packages/shared/src/constants.ts:1218`) until PR-3 lands → declared in the manifest capability array with a cast (Task 2).
  - PR-3 host API `ctx.companies.setStanding(companyId, { status: "active"|"grace"|"blocked", reason: string, message: string, actionUrl?: string })` and `ctx.companies.clearStanding(companyId)`. The SDK's `PluginCompaniesClient` (`packages/plugins/sdk/src/types.ts:1071`) has only `list`/`get` today → the plugin accesses standing through one narrow adapter (`standingWriterFromContext`, Task 5) that casts; tests attach fakes. When PR-3 lands, only that one file's cast is deleted.
  - PR-1 delivers standings/banners to the UI (capabilities payload). This plugin only **writes** standing; it renders no core banners.
- **Verbatim contracts**: `BillingProvider` must match spec §5 (same method names, same request/response field names; typed transliteration only — spec block uses TS shorthand without types). Standing writes must match the PR-3 contract signature above exactly.
- **Ledger invariant**: every `subscriptions` write is caused by exactly one `billing_events` row (unique `idempotency_key`). Lifecycle transitions go through `applyBillingEvent` (ledger row → pure transition → persist → mark applied → provider effects → standing; standing failure is retried by the sweep, never blocks the ledger). The only non-transition writes are bookkeeping paths that write their own already-applied ledger row: row creation (`creation.ts`, `subscription.created`/`trial.started`), checkout session attach (`service.ts`, `checkout.created`) and stale-session clearing (`service.ts`/`sweep.ts`, `checkout.expired`).
- **DB namespace**: `plugin_billing_d8ffbbf605` — derived by the host as `plugin_<namespaceSlug>_<sha256(manifest.id).hex[0:10]>` (`server/src/services/plugin-database.ts:33-43`) from `namespaceSlug: "billing"` and id `paperclip-plugin-billing`. All migration SQL and all runtime SQL is schema-qualified with this exact literal (the host validator rejects anything outside the namespace except declared `coreReadTables`).
- **Test commands**: from repo root, `pnpm --filter @paperclipai/plugin-billing test` (all) or `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/<file>.spec.ts` (one file). Core-UI task uses `pnpm --filter @paperclipai/ui exec vitest run src/components/NewCompanyDialog.test.tsx`. Typecheck: `pnpm --filter @paperclipai/plugin-billing typecheck`.
- **Repo conventions**: TypeScript strict; conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; NEVER commit `pnpm-lock.yaml` (refresh-bot owns it; `OUTDATED_LOCKFILE` on verify is accepted); PRs touching UI surfaces need committed screenshots (capture at PR-prep time, not per task).
- **No placeholder emails**: the SDK exposes no user email/name (`PluginAccessMember` carries only `principalId`). `ensureCustomer` is called with `{ id: ownerUserId, email: "user-" + ownerUserId + "@billing.invalid", name: ownerUserId }`; the stub ignores them. Recorded in `STRIPE_ADAPTER.md` as a host-API gap to close before the Stripe adapter.
- **Known contract deviations (all code-grounded, full list also at each task)**:
  1. *Webhook 400*: the host webhook route (`server/src/routes/plugins.ts:2616`) returns **502** (delivery `failed`) when the worker throws, and 200 only on clean return. Spec §5 "unverifiable ⇒ 400" is honored in substance (non-2xx, no state change) but the literal status the external caller sees is 502.
  2. *Admin endpoints are bridge actions, not `apiRoutes`*: scoped `apiRoutes` always resolve a company and assert only company access (`server/src/routes/plugins.ts:1812-1818`) — there is no instance-admin assertion available on that path. The bridge, however, asserts `assertInstanceAdmin` whenever a call carries **no** `companyId` (`assertPluginBridgeScope`, `server/src/routes/plugins.ts:707-711`). Admin operations therefore ride `ctx.data`/`ctx.actions` with a no-company scope, and the worker enforces the matching invariants (Tasks 14–15).
  3. *Extra columns beyond spec §4's tables*: `subscriptions.owner_user_id` (trial-eligibility anchor + payer), `grace_since` (§6.2 needs "graceDays passed" measurable), `open_checkout_url` (§6.3 requires reusing the one live session; the ref alone cannot reproduce the URL), `billing_events.company_id` (per-company history for the UI). No FK from `subscriptions.company_id` to `public.companies` — deletion reconciliation (§6.2 "never bill a ghost") requires the row to survive company deletion.
  4. *Event catalog*: `company.created` exists and is delivered to plugins (declared in `PLUGIN_EVENT_TYPES` `packages/shared/src/constants.ts:1559`, forwarded via `logActivity` → `publishPluginDomainEvent`, `server/src/services/activity-log.ts:100-118`; emitted by `server/src/routes/companies.ts:414`). **`company.deleted` does not exist** (the delete route `companies.ts:546` logs nothing) → deletion detection is sweep-only, by design of this plan.
  5. *Webhook resolution fallback*: `verifyAndParseWebhook`'s union carries no event id and one-click activation returns no `subRef` (spec-verbatim), so the ledger idempotency key is `sha256(rawBody)` and event→subscription resolution is sessionRef → providerSubscriptionId → `rawPayload.companyId` (the stub includes `companyId` in every event body; a Stripe adapter gets it from subscription metadata).

---

## Task 1: Package scaffold

**Files:**
- Create: `packages/plugins/plugin-billing/package.json`
- Create: `packages/plugins/plugin-billing/tsconfig.json`
- Create: `packages/plugins/plugin-billing/vitest.config.ts`
- Create: `packages/plugins/plugin-billing/esbuild.config.mjs`
- Create: `packages/plugins/plugin-billing/.gitignore`
- Create: `packages/plugins/plugin-billing/src/constants.ts`
- Test: `packages/plugins/plugin-billing/tests/constants.spec.ts`

**Interfaces:**
- Consumes: `createPluginBundlerPresets` from `@paperclipai/plugin-sdk/bundlers` (same as `packages/plugins/plugin-llm-wiki/esbuild.config.mjs`).
- Produces: `PLUGIN_ID`, `DB_NAMESPACE`, `WEBHOOK_ENDPOINT_KEY`, `WEBHOOK_PATH`, `SWEEP_JOB_KEY`, `STUB_SIGNATURE_HEADER`, `BILLING_PAGE_PATH`, `CHECKOUT_PAGE_ROUTE`, `PROVIDER_STUB` constants used by every later task.

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/constants.spec.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BILLING_PAGE_PATH,
  CHECKOUT_PAGE_ROUTE,
  DB_NAMESPACE,
  PLUGIN_ID,
  PROVIDER_STUB,
  STUB_SIGNATURE_HEADER,
  SWEEP_JOB_KEY,
  WEBHOOK_ENDPOINT_KEY,
  WEBHOOK_PATH,
} from "../src/constants.js";

describe("constants", () => {
  it("uses the spec-locked plugin id", () => {
    expect(PLUGIN_ID).toBe("paperclip-plugin-billing");
  });

  it("DB_NAMESPACE matches the host derivation plugin_<slug>_<sha256(id)[0:10]>", () => {
    // Mirrors derivePluginDatabaseNamespace in server/src/services/plugin-database.ts
    const hash = createHash("sha256").update(PLUGIN_ID).digest("hex").slice(0, 10);
    expect(DB_NAMESPACE).toBe(`plugin_billing_${hash}`);
    expect(DB_NAMESPACE).toBe("plugin_billing_d8ffbbf605");
  });

  it("webhook path matches the host route shape", () => {
    expect(WEBHOOK_ENDPOINT_KEY).toBe("provider");
    expect(WEBHOOK_PATH).toBe("/api/plugins/paperclip-plugin-billing/webhooks/provider");
  });

  it("misc keys are stable", () => {
    expect(SWEEP_JOB_KEY).toBe("billing-sweep");
    expect(STUB_SIGNATURE_HEADER).toBe("x-billing-stub-signature");
    expect(BILLING_PAGE_PATH).toBe("company/settings/billing");
    expect(CHECKOUT_PAGE_ROUTE).toBe("billing-checkout");
    expect(PROVIDER_STUB).toBe("stub");
  });
});
```

- [ ] Create `packages/plugins/plugin-billing/package.json`:

```json
{
  "name": "@paperclipai/plugin-billing",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Self-contained billing plugin: flat monthly fee per company, configurable trial, provider-pluggable checkout with a functional stub provider, enforcement via company standing.",
  "files": ["dist", "migrations", "README.md", "STRIPE_ADAPTER.md"],
  "scripts": {
    "prebuild": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps",
    "build": "node ./esbuild.config.mjs",
    "dev": "node ./esbuild.config.mjs --watch",
    "test": "vitest run --config ./vitest.config.ts",
    "typecheck": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && tsc --noEmit"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  },
  "keywords": ["paperclip", "plugin", "billing", "subscriptions"],
  "author": "Paperclip",
  "license": "MIT",
  "devDependencies": {
    "@paperclipai/plugin-sdk": "workspace:*",
    "@types/node": "^22.19.21",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "esbuild": "^0.28.1",
    "react-dom": "^19.2.7",
    "typescript": "^5.7.3",
    "vitest": "^4.1.8"
  },
  "peerDependencies": {
    "react": ">=18"
  }
}
```

- [ ] Create `packages/plugins/plugin-billing/tsconfig.json` (copy of plugin-llm-wiki's):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "tests"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] Create `packages/plugins/plugin-billing/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts", "tests/**/*.spec.tsx"],
    environment: "node",
  },
});
```

- [ ] Create `packages/plugins/plugin-billing/esbuild.config.mjs` (identical mechanism to plugin-llm-wiki):

```js
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
```

- [ ] Create `packages/plugins/plugin-billing/.gitignore`:

```
dist/
node_modules/
```

- [ ] Run `pnpm install` from repo root (registers the new workspace package). Do NOT commit the lockfile change.
- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/constants.spec.ts` — expect failure: `Cannot find module '../src/constants.js'`.
- [ ] Create `packages/plugins/plugin-billing/src/constants.ts`:

```ts
export const PLUGIN_ID = "paperclip-plugin-billing";

/**
 * Host-derived Postgres schema for this plugin:
 * plugin_<namespaceSlug>_<sha256(PLUGIN_ID).hex.slice(0, 10)>
 * (server/src/services/plugin-database.ts). namespaceSlug is "billing".
 */
export const DB_NAMESPACE = "plugin_billing_d8ffbbf605";

export const WEBHOOK_ENDPOINT_KEY = "provider";
export const WEBHOOK_PATH = `/api/plugins/${PLUGIN_ID}/webhooks/${WEBHOOK_ENDPOINT_KEY}`;

export const SWEEP_JOB_KEY = "billing-sweep";

/** Header carrying the hex HMAC-SHA256 of the raw stub event body. */
export const STUB_SIGNATURE_HEADER = "x-billing-stub-signature";

/** Company-relative path of the plugin's Billing company-settings page. */
export const BILLING_PAGE_PATH = "company/settings/billing";

/** routePath of the stub checkout simulator `page` slot (mounted at /:companyPrefix/billing-checkout). */
export const CHECKOUT_PAGE_ROUTE = "billing-checkout";

export const PROVIDER_STUB = "stub";
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/constants.spec.ts` — expect 4 passing tests.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing
git commit -m "feat(plugin-billing): scaffold package with build config and stable constants

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Manifest

**Files:**
- Create: `packages/plugins/plugin-billing/src/manifest.ts`
- Test: `packages/plugins/plugin-billing/tests/manifest.spec.ts`

**Interfaces:**
- Consumes: `PaperclipPluginManifestV1`, `PluginCapability` types from `@paperclipai/plugin-sdk`; constants from Task 1.
- Produces: default export `manifest: PaperclipPluginManifestV1` declaring capabilities, `database{namespaceSlug:"billing", migrationsDir:"migrations", coreReadTables:["companies"]}`, jobs (`billing-sweep`, cron `0 4 * * *`), webhooks (`endpointKey:"provider"`), 8 board apiRoutes with `companyResolution`, ui slots (`companySettingsPage` "Billing" routePath `billing`, `settingsPage`, `page` routePath `billing-checkout`), `instanceConfigSchema` per spec §3, and PR-2's `companyEnablement: { default: "on", locked: true }`.

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/manifest.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { CHECKOUT_PAGE_ROUTE, PLUGIN_ID, SWEEP_JOB_KEY, WEBHOOK_ENDPOINT_KEY } from "../src/constants.js";

describe("manifest", () => {
  it("declares identity and categories", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.categories).toEqual(["automation", "ui"]);
    expect(manifest.entrypoints).toEqual({ worker: "./dist/worker.js", ui: "./dist/ui" });
  });

  it("declares exactly the required capabilities", () => {
    expect([...manifest.capabilities].sort()).toEqual(
      [
        "access.members.read",
        "activity.log.write",
        "api.routes.register",
        "companies.read",
        "company.standing.write",
        "costs.read",
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
        "events.subscribe",
        "http.outbound",
        "instance.settings.register",
        "jobs.schedule",
        "plugin.state.read",
        "plugin.state.write",
        "ui.page.register",
        "webhooks.receive",
      ].sort(),
    );
  });

  it("declares the PR-2 locked-on company enablement", () => {
    expect((manifest as Record<string, unknown>).companyEnablement).toEqual({
      default: "on",
      locked: true,
    });
  });

  it("declares database namespace, daily sweep job, and provider webhook", () => {
    expect(manifest.database).toEqual({
      namespaceSlug: "billing",
      migrationsDir: "migrations",
      coreReadTables: ["companies"],
    });
    expect(manifest.jobs).toEqual([
      {
        jobKey: SWEEP_JOB_KEY,
        displayName: "Billing sweep",
        description:
          "Daily reconciliation: creates missing subscription rows, applies time-based transitions, reconciles company standing, cancels subscriptions of deleted companies, replays unapplied ledger events, and delivers due stub-provider events.",
        schedule: "0 4 * * *",
      },
    ]);
    expect(manifest.webhooks).toEqual([
      {
        endpointKey: WEBHOOK_ENDPOINT_KEY,
        displayName: "Billing provider events",
        description: "Signed billing provider events (stub provider in v1). Signature-verified in the worker; unverifiable deliveries change no state.",
      },
    ]);
  });

  it("declares board apiRoutes with company resolution", () => {
    const routes = (manifest.apiRoutes ?? []).map((r) => ({
      routeKey: r.routeKey,
      method: r.method,
      path: r.path,
      auth: r.auth,
      companyResolution: r.companyResolution,
    }));
    expect(routes).toEqual([
      { routeKey: "creation-summary", method: "GET", path: "/creation-summary", auth: "board", companyResolution: { from: "query", key: "companyId" } },
      { routeKey: "summary", method: "GET", path: "/summary", auth: "board", companyResolution: { from: "query", key: "companyId" } },
      { routeKey: "create-checkout", method: "POST", path: "/checkout", auth: "board", companyResolution: { from: "body", key: "companyId" } },
      { routeKey: "resolve-checkout", method: "POST", path: "/checkout/resolve", auth: "board", companyResolution: { from: "body", key: "companyId" } },
      { routeKey: "one-click", method: "POST", path: "/subscribe/one-click", auth: "board", companyResolution: { from: "body", key: "companyId" } },
      { routeKey: "cancel", method: "POST", path: "/cancel", auth: "board", companyResolution: { from: "body", key: "companyId" } },
      { routeKey: "resume", method: "POST", path: "/resume", auth: "board", companyResolution: { from: "body", key: "companyId" } },
      { routeKey: "portal", method: "POST", path: "/portal", auth: "board", companyResolution: { from: "body", key: "companyId" } },
    ]);
    for (const route of manifest.apiRoutes ?? []) {
      expect(route.capability).toBe("api.routes.register");
    }
  });

  it("declares the three UI slots", () => {
    expect(manifest.ui?.slots).toEqual([
      { type: "companySettingsPage", id: "billing-company-page", displayName: "Billing", exportName: "BillingPage", routePath: "billing" },
      { type: "settingsPage", id: "billing-admin-page", displayName: "Billing", exportName: "BillingAdminPage" },
      { type: "page", id: "billing-checkout-page", displayName: "Checkout", exportName: "StubCheckoutPage", routePath: CHECKOUT_PAGE_ROUTE },
    ]);
  });

  it("declares the instance config schema per spec §3", () => {
    const schema = manifest.instanceConfigSchema as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.currency).toMatchObject({ type: "string", default: "EUR" });
    expect(schema.properties.defaultMonthlyPriceCents).toMatchObject({ type: "integer", default: 4900, minimum: 0 });
    expect(schema.properties.trialDays).toMatchObject({ type: "integer", default: 7, minimum: 0 });
    expect(schema.properties.graceDays).toMatchObject({ type: "integer", default: 7, minimum: 0 });
    expect(schema.properties.trialPolicy).toMatchObject({
      type: "string",
      enum: ["first-company-per-owner", "every-company", "none"],
      default: "first-company-per-owner",
    });
    expect(schema.properties.provider).toMatchObject({ type: "string", enum: ["stub"], default: "stub" });
    expect(schema.properties.instanceBaseUrl).toMatchObject({
      type: "string",
      default: "http://127.0.0.1:3100",
      "x-paperclip-advanced": true,
    });
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/manifest.spec.ts` — expect failure: cannot find `../src/manifest.js`.
- [ ] Create `packages/plugins/plugin-billing/src/manifest.ts`:

```ts
import type { PaperclipPluginManifestV1, PluginCapability } from "@paperclipai/plugin-sdk";
import { CHECKOUT_PAGE_ROUTE, PLUGIN_ID, SWEEP_JOB_KEY, WEBHOOK_ENDPOINT_KEY } from "./constants.js";

/**
 * "company.standing.write" is added to PLUGIN_CAPABILITIES by PR-3
 * (2026-07-18-settings-visibility-and-plugin-enablement-design.md §5.2).
 * Until PR-3 lands in this branch the shared union does not contain it, so it
 * is declared through a cast. Delete the cast when PR-3 merges.
 */
const capabilities: PluginCapability[] = [
  "companies.read",
  "access.members.read",
  "costs.read",
  "company.standing.write" as PluginCapability,
  "database.namespace.read",
  "database.namespace.write",
  "database.namespace.migrate",
  "plugin.state.read",
  "plugin.state.write",
  "events.subscribe",
  "jobs.schedule",
  "webhooks.receive",
  "api.routes.register",
  "http.outbound",
  "activity.log.write",
  "instance.settings.register",
  "ui.page.register",
];

/**
 * `companyEnablement` is the PR-2 manifest field (same design doc §4.2).
 * `locked: true` + `default: "on"` means a company can never dodge billing by
 * disabling the plugin. Typed via intersection until PR-2 extends the shared
 * manifest type.
 */
const manifest: PaperclipPluginManifestV1 & {
  companyEnablement: { default: "on" | "off"; locked?: boolean };
} = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Billing",
  description:
    "Flat monthly subscription billing per company with configurable trials, a fully functional stub payment provider, and run-blocking enforcement via company standing.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities,
  companyEnablement: { default: "on", locked: true },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "billing",
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      currency: {
        type: "string",
        title: "Currency (ISO code)",
        default: "EUR",
        minLength: 3,
        maxLength: 3,
      },
      defaultMonthlyPriceCents: {
        type: "integer",
        title: "Default monthly price (cents)",
        default: 4900,
        minimum: 0,
      },
      trialDays: {
        type: "integer",
        title: "Trial length (days)",
        default: 7,
        minimum: 0,
      },
      graceDays: {
        type: "integer",
        title: "Grace period (days)",
        description: "Aligned with provider dunning windows.",
        default: 7,
        minimum: 0,
      },
      trialPolicy: {
        type: "string",
        title: "Trial policy",
        enum: ["first-company-per-owner", "every-company", "none"],
        default: "first-company-per-owner",
      },
      provider: {
        type: "string",
        title: "Payment provider",
        enum: ["stub"],
        default: "stub",
      },
      instanceBaseUrl: {
        type: "string",
        title: "Instance base URL",
        description:
          "Base URL the stub provider uses to POST signed events to this plugin's own webhook endpoint. Provider secrets for real providers resolve via secret refs, never raw config.",
        default: "http://127.0.0.1:3100",
        "x-paperclip-advanced": true,
        "x-paperclip-group": "Stub provider",
      },
    },
  },
  jobs: [
    {
      jobKey: SWEEP_JOB_KEY,
      displayName: "Billing sweep",
      description:
        "Daily reconciliation: creates missing subscription rows, applies time-based transitions, reconciles company standing, cancels subscriptions of deleted companies, replays unapplied ledger events, and delivers due stub-provider events.",
      schedule: "0 4 * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_ENDPOINT_KEY,
      displayName: "Billing provider events",
      description:
        "Signed billing provider events (stub provider in v1). Signature-verified in the worker; unverifiable deliveries change no state.",
    },
  ],
  apiRoutes: [
    { routeKey: "creation-summary", method: "GET", path: "/creation-summary", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "summary", method: "GET", path: "/summary", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "create-checkout", method: "POST", path: "/checkout", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "resolve-checkout", method: "POST", path: "/checkout/resolve", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "one-click", method: "POST", path: "/subscribe/one-click", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "cancel", method: "POST", path: "/cancel", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "resume", method: "POST", path: "/resume", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "portal", method: "POST", path: "/portal", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
  ],
  ui: {
    slots: [
      {
        type: "companySettingsPage",
        id: "billing-company-page",
        displayName: "Billing",
        exportName: "BillingPage",
        routePath: "billing",
      },
      {
        type: "settingsPage",
        id: "billing-admin-page",
        displayName: "Billing",
        exportName: "BillingAdminPage",
      },
      {
        type: "page",
        id: "billing-checkout-page",
        displayName: "Checkout",
        exportName: "StubCheckoutPage",
        routePath: CHECKOUT_PAGE_ROUTE,
      },
    ],
  },
};

export default manifest;
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/manifest.spec.ts` — expect all tests passing.
- [ ] Run `pnpm --filter @paperclipai/plugin-billing typecheck` — expect clean (the two documented casts compile under strict mode).
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing
git commit -m "feat(plugin-billing): manifest with capabilities, sweep job, webhook, api routes, ui slots, config schema

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Namespace migrations

**Files:**
- Create: `packages/plugins/plugin-billing/migrations/001_billing.sql`
- Create: `packages/plugins/plugin-billing/migrations/002_stub_provider.sql`
- Test: `packages/plugins/plugin-billing/tests/migrations.spec.ts`

**Interfaces:**
- Consumes: host migration runner (`server/src/services/plugin-database.ts`) applies `migrations/*.sql` in filename order before worker startup; every statement must be DDL or namespace-scoped backfill, schema-qualified with `plugin_billing_d8ffbbf605` (the literal — the runner does no templating; `plugin-llm-wiki/migrations/001_llm_wiki.sql` is the precedent).
- Produces: tables `billing_customers`, `subscriptions`, `billing_events` (spec §4) and `stub_state` (stub provider persistence).

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/migrations.spec.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DB_NAMESPACE } from "../src/constants.js";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

function read(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), "utf8");
}

describe("migrations", () => {
  it("ships exactly the expected migration files", () => {
    const files = readdirSync(MIGRATIONS_DIR).sort();
    expect(files).toEqual(["001_billing.sql", "002_stub_provider.sql"]);
  });

  it("every CREATE statement is qualified with the plugin namespace", () => {
    for (const file of ["001_billing.sql", "002_stub_provider.sql"]) {
      const statements = read(file)
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement.startsWith("CREATE"));
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement, `${file}: ${statement.slice(0, 60)}`).toContain(`${DB_NAMESPACE}.`);
      }
    }
  });

  it("001 creates the three spec §4 tables with the required columns", () => {
    const sql = read("001_billing.sql");
    expect(sql).toContain(`CREATE TABLE ${DB_NAMESPACE}.billing_customers`);
    expect(sql).toContain(`CREATE TABLE ${DB_NAMESPACE}.subscriptions`);
    expect(sql).toContain(`CREATE TABLE ${DB_NAMESPACE}.billing_events`);
    for (const column of ["user_id", "provider_customer_id", "has_default_payment_method"]) {
      expect(sql).toContain(column);
    }
    for (const column of [
      "company_id uuid NOT NULL UNIQUE",
      "owner_user_id",
      "trial_ends_at",
      "grace_since",
      "current_period_end",
      "cancel_at_period_end",
      "price_cents_override",
      "provider_subscription_id",
      "open_checkout_session_ref",
      "open_checkout_url",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("idempotency_key text NOT NULL UNIQUE");
    expect(sql).toContain(
      "CHECK (status IN ('trialing','awaiting_payment','active','grace','blocked','canceled','complimentary'))",
    );
    // Deliberately NO foreign key to public.companies: subscription rows must
    // survive company deletion so the sweep can cancel at the provider.
    expect(sql).not.toContain("REFERENCES public.companies");
  });

  it("002 creates and seeds the singleton stub_state row", () => {
    const sql = read("002_stub_provider.sql");
    expect(sql).toContain(`CREATE TABLE ${DB_NAMESPACE}.stub_state`);
    expect(sql).toContain(`INSERT INTO ${DB_NAMESPACE}.stub_state`);
    expect(sql).toContain("CHECK (id = 1)");
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/migrations.spec.ts` — expect failure: missing migrations directory.
- [ ] Create `packages/plugins/plugin-billing/migrations/001_billing.sql`:

```sql
CREATE TABLE plugin_billing_d8ffbbf605.billing_customers (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  provider text NOT NULL,
  provider_customer_id text NOT NULL,
  has_default_payment_method boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, user_id)
);

CREATE TABLE plugin_billing_d8ffbbf605.subscriptions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL UNIQUE,
  owner_user_id text NOT NULL,
  customer_id uuid REFERENCES plugin_billing_d8ffbbf605.billing_customers(id),
  status text NOT NULL CHECK (status IN ('trialing','awaiting_payment','active','grace','blocked','canceled','complimentary')),
  trial_ends_at timestamptz,
  grace_since timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  price_cents_override integer,
  provider_subscription_id text,
  open_checkout_session_ref text,
  open_checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_provider_sub_idx
  ON plugin_billing_d8ffbbf605.subscriptions (provider_subscription_id);

CREATE INDEX subscriptions_open_session_idx
  ON plugin_billing_d8ffbbf605.subscriptions (open_checkout_session_ref);

CREATE TABLE plugin_billing_d8ffbbf605.billing_events (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  type text NOT NULL,
  subscription_id uuid REFERENCES plugin_billing_d8ffbbf605.subscriptions(id),
  company_id uuid,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX billing_events_company_idx
  ON plugin_billing_d8ffbbf605.billing_events (company_id, created_at DESC);

CREATE INDEX billing_events_unapplied_idx
  ON plugin_billing_d8ffbbf605.billing_events (created_at)
  WHERE applied_at IS NULL;

CREATE INDEX billing_events_trial_owner_idx
  ON plugin_billing_d8ffbbf605.billing_events ((raw_payload->>'ownerUserId'))
  WHERE type = 'trial.started';
```

- [ ] Create `packages/plugins/plugin-billing/migrations/002_stub_provider.sql`:

```sql
CREATE TABLE plugin_billing_d8ffbbf605.stub_state (
  id integer PRIMARY KEY CHECK (id = 1),
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plugin_billing_d8ffbbf605.stub_state (id, state) VALUES (1, '{}'::jsonb);
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/migrations.spec.ts` — expect all passing.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/migrations packages/plugins/plugin-billing/tests/migrations.spec.ts
git commit -m "feat(plugin-billing): namespace migrations for customers, subscriptions, ledger, stub state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 4: Billing config parsing

**Files:**
- Create: `packages/plugins/plugin-billing/src/config.ts`
- Test: `packages/plugins/plugin-billing/tests/config.spec.ts`

**Interfaces:**
- Consumes: raw `Record<string, unknown>` from `ctx.config.get(companyId?)`.
- Produces:

```ts
export type TrialPolicy = "first-company-per-owner" | "every-company" | "none";
export interface BillingConfig {
  currency: string;
  defaultMonthlyPriceCents: number;
  trialDays: number;
  graceDays: number;
  trialPolicy: TrialPolicy;
  provider: "stub";
  instanceBaseUrl: string;
}
export const DEFAULT_BILLING_CONFIG: BillingConfig;
export function parseBillingConfig(raw: Record<string, unknown> | null | undefined): BillingConfig;
```

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/config.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_BILLING_CONFIG, parseBillingConfig } from "../src/config.js";

describe("parseBillingConfig", () => {
  it("returns spec defaults for empty/missing config", () => {
    expect(parseBillingConfig(undefined)).toEqual(DEFAULT_BILLING_CONFIG);
    expect(parseBillingConfig({})).toEqual(DEFAULT_BILLING_CONFIG);
    expect(DEFAULT_BILLING_CONFIG).toEqual({
      currency: "EUR",
      defaultMonthlyPriceCents: 4900,
      trialDays: 7,
      graceDays: 7,
      trialPolicy: "first-company-per-owner",
      provider: "stub",
      instanceBaseUrl: "http://127.0.0.1:3100",
    });
  });

  it("accepts valid overrides", () => {
    expect(
      parseBillingConfig({
        currency: "USD",
        defaultMonthlyPriceCents: 9900,
        trialDays: 14,
        graceDays: 3,
        trialPolicy: "every-company",
        provider: "stub",
        instanceBaseUrl: "http://paperclip.internal:3100",
      }),
    ).toEqual({
      currency: "USD",
      defaultMonthlyPriceCents: 9900,
      trialDays: 14,
      graceDays: 3,
      trialPolicy: "every-company",
      provider: "stub",
      instanceBaseUrl: "http://paperclip.internal:3100",
    });
  });

  it("falls back per-field on invalid values (never throws — billing must fail safe)", () => {
    const parsed = parseBillingConfig({
      currency: 42,
      defaultMonthlyPriceCents: -5,
      trialDays: "soon",
      graceDays: -1,
      trialPolicy: "sometimes",
      provider: "stripe",
      instanceBaseUrl: 0,
    });
    expect(parsed).toEqual(DEFAULT_BILLING_CONFIG);
  });

  it("allows zero trialDays and zero graceDays", () => {
    const parsed = parseBillingConfig({ trialDays: 0, graceDays: 0 });
    expect(parsed.trialDays).toBe(0);
    expect(parsed.graceDays).toBe(0);
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/config.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/config.ts`:

```ts
export type TrialPolicy = "first-company-per-owner" | "every-company" | "none";

export interface BillingConfig {
  /** ISO 4217 code, e.g. "EUR". */
  currency: string;
  defaultMonthlyPriceCents: number;
  trialDays: number;
  /** Aligned with provider dunning windows. */
  graceDays: number;
  trialPolicy: TrialPolicy;
  provider: "stub";
  /** Base URL the stub provider posts its signed events back to. */
  instanceBaseUrl: string;
}

export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  currency: "EUR",
  defaultMonthlyPriceCents: 4900,
  trialDays: 7,
  graceDays: 7,
  trialPolicy: "first-company-per-owner",
  provider: "stub",
  instanceBaseUrl: "http://127.0.0.1:3100",
};

const TRIAL_POLICIES: readonly TrialPolicy[] = ["first-company-per-owner", "every-company", "none"];

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Per-field lenient parse. Billing must never crash on a bad config value:
 * an unparseable field falls back to its spec §3 default.
 */
export function parseBillingConfig(raw: Record<string, unknown> | null | undefined): BillingConfig {
  const input = raw ?? {};
  return {
    currency: typeof input.currency === "string" && /^[A-Za-z]{3}$/.test(input.currency)
      ? input.currency.toUpperCase()
      : DEFAULT_BILLING_CONFIG.currency,
    defaultMonthlyPriceCents: nonNegativeInt(input.defaultMonthlyPriceCents, DEFAULT_BILLING_CONFIG.defaultMonthlyPriceCents),
    trialDays: nonNegativeInt(input.trialDays, DEFAULT_BILLING_CONFIG.trialDays),
    graceDays: nonNegativeInt(input.graceDays, DEFAULT_BILLING_CONFIG.graceDays),
    trialPolicy: TRIAL_POLICIES.includes(input.trialPolicy as TrialPolicy)
      ? (input.trialPolicy as TrialPolicy)
      : DEFAULT_BILLING_CONFIG.trialPolicy,
    provider: "stub",
    instanceBaseUrl: nonEmptyString(input.instanceBaseUrl, DEFAULT_BILLING_CONFIG.instanceBaseUrl),
  };
}
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/config.spec.ts` — expect all passing.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/config.ts packages/plugins/plugin-billing/tests/config.spec.ts
git commit -m "feat(plugin-billing): lenient instance config parsing with spec defaults

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Domain types and standing-writer adapter

**Files:**
- Create: `packages/plugins/plugin-billing/src/domain.ts`
- Create: `packages/plugins/plugin-billing/src/standing.ts`
- Test: `packages/plugins/plugin-billing/tests/standing.spec.ts`

**Interfaces:**
- Consumes: `PluginContext` from `@paperclipai/plugin-sdk`; PR-3 host API `ctx.companies.setStanding(companyId, { status, reason, message, actionUrl? })` / `ctx.companies.clearStanding(companyId)` (via cast until PR-3's SDK types land).
- Produces (used by every later task):

```ts
// domain.ts
export type SubscriptionStatus = "trialing" | "awaiting_payment" | "active" | "grace" | "blocked" | "canceled" | "complimentary";
export interface SubscriptionRow { id: string; companyId: string; ownerUserId: string; customerId: string | null; status: SubscriptionStatus; trialEndsAt: string | null; graceSince: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; priceCentsOverride: number | null; providerSubscriptionId: string | null; openCheckoutSessionRef: string | null; openCheckoutUrl: string | null; createdAt: string; updatedAt: string; }
export interface CustomerRow { id: string; userId: string; provider: string; providerCustomerId: string; hasDefaultPaymentMethod: boolean; }
export interface LedgerInsert { id: string; idempotencyKey: string; type: string; subscriptionId: string | null; companyId: string | null; rawPayload: Record<string, unknown>; }
export interface LedgerRow extends LedgerInsert { appliedAt: string | null; createdAt: string; }
export type BillingEvent =
  | { type: "clock" }
  | { type: "checkout.completed"; sessionRef: string; subRef: string; periodEnd: string }
  | { type: "one_click.activated"; subRef: string | null; periodEnd: string }
  | { type: "payment.succeeded"; subRef: string; periodEnd: string }
  | { type: "payment.failed"; subRef: string }
  | { type: "subscription.canceled"; subRef: string }
  | { type: "owner.cancel_at_period_end" }
  | { type: "owner.resume" }
  | { type: "admin.set_price_override"; priceCents: number | null }
  | { type: "admin.extend_trial"; trialEndsAt: string }
  | { type: "company.deleted" };
export type StandingCommand = { kind: "clear" } | { kind: "set"; status: "active" | "grace" | "blocked"; reason: string; message: string; actionUrl?: string };
export class BillingUserError extends Error { readonly code: string; constructor(code: string, message: string); }

// standing.ts
export interface StandingWriter { set(companyId: string, input: { status: "active" | "grace" | "blocked"; reason: string; message: string; actionUrl?: string }): Promise<void>; clear(companyId: string): Promise<void>; }
export function standingWriterFromContext(ctx: PluginContext): StandingWriter;
export async function applyStandingCommand(writer: StandingWriter, companyId: string, command: StandingCommand): Promise<void>;
```

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/standing.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { applyStandingCommand, standingWriterFromContext } from "../src/standing.js";

function fakeCtx() {
  const setStanding = vi.fn(async () => {});
  const clearStanding = vi.fn(async () => {});
  const ctx = { companies: { setStanding, clearStanding } } as unknown as PluginContext;
  return { ctx, setStanding, clearStanding };
}

describe("standingWriterFromContext", () => {
  it("forwards set() to ctx.companies.setStanding with the exact PR-3 payload", async () => {
    const { ctx, setStanding } = fakeCtx();
    const writer = standingWriterFromContext(ctx);
    await writer.set("co-1", {
      status: "blocked",
      reason: "awaiting_subscription",
      message: "Needs a subscription.",
      actionUrl: "company/settings/billing",
    });
    expect(setStanding).toHaveBeenCalledExactlyOnceWith("co-1", {
      status: "blocked",
      reason: "awaiting_subscription",
      message: "Needs a subscription.",
      actionUrl: "company/settings/billing",
    });
  });

  it("forwards clear() to ctx.companies.clearStanding", async () => {
    const { ctx, clearStanding } = fakeCtx();
    await standingWriterFromContext(ctx).clear("co-2");
    expect(clearStanding).toHaveBeenCalledExactlyOnceWith("co-2");
  });
});

describe("applyStandingCommand", () => {
  it("routes set/clear commands", async () => {
    const set = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    const writer = { set, clear };
    await applyStandingCommand(writer, "co-1", { kind: "clear" });
    expect(clear).toHaveBeenCalledExactlyOnceWith("co-1");
    await applyStandingCommand(writer, "co-1", {
      kind: "set", status: "grace", reason: "trial_ended", message: "m", actionUrl: "a",
    });
    expect(set).toHaveBeenCalledExactlyOnceWith("co-1", {
      status: "grace", reason: "trial_ended", message: "m", actionUrl: "a",
    });
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/standing.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/domain.ts`:

```ts
export type SubscriptionStatus =
  | "trialing"
  | "awaiting_payment"
  | "active"
  | "grace"
  | "blocked"
  | "canceled"
  | "complimentary";

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "awaiting_payment",
  "active",
  "grace",
  "blocked",
  "canceled",
  "complimentary",
];

/** One row per company (spec §4). Timestamps are ISO 8601 strings. */
export interface SubscriptionRow {
  id: string;
  companyId: string;
  /** Payer / trial-eligibility anchor: company owner at row-creation time. */
  ownerUserId: string;
  customerId: string | null;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  /** When the row entered `grace` (drives the graceDays deadline). */
  graceSince: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** 0 ⇒ complimentary. */
  priceCentsOverride: number | null;
  providerSubscriptionId: string | null;
  /** Enforces one live checkout session per company. */
  openCheckoutSessionRef: string | null;
  openCheckoutUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerRow {
  id: string;
  userId: string;
  provider: string;
  providerCustomerId: string;
  hasDefaultPaymentMethod: boolean;
}

export interface LedgerInsert {
  id: string;
  idempotencyKey: string;
  type: string;
  subscriptionId: string | null;
  companyId: string | null;
  rawPayload: Record<string, unknown>;
}

export interface LedgerRow extends LedgerInsert {
  appliedAt: string | null;
  createdAt: string;
}

/** Internal event vocabulary consumed by the pure state machine. */
export type BillingEvent =
  | { type: "clock" }
  | { type: "checkout.completed"; sessionRef: string; subRef: string; periodEnd: string }
  | { type: "one_click.activated"; subRef: string | null; periodEnd: string }
  | { type: "payment.succeeded"; subRef: string; periodEnd: string }
  | { type: "payment.failed"; subRef: string }
  | { type: "subscription.canceled"; subRef: string }
  | { type: "owner.cancel_at_period_end" }
  | { type: "owner.resume" }
  | { type: "admin.set_price_override"; priceCents: number | null }
  | { type: "admin.extend_trial"; trialEndsAt: string }
  | { type: "company.deleted" };

export type StandingCommand =
  | { kind: "clear" }
  | {
      kind: "set";
      status: "active" | "grace" | "blocked";
      reason: string;
      message: string;
      actionUrl?: string;
    };

/** User-presentable, typed error surfaced as 4xx by api routes and bridge handlers. */
export class BillingUserError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BillingUserError";
    this.code = code;
  }
}
```

- [ ] Create `packages/plugins/plugin-billing/src/standing.ts`:

```ts
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { StandingCommand } from "./domain.js";

export interface StandingSetInput {
  status: "active" | "grace" | "blocked";
  reason: string;
  message: string;
  actionUrl?: string;
}

export interface StandingWriter {
  set(companyId: string, input: StandingSetInput): Promise<void>;
  clear(companyId: string): Promise<void>;
}

/**
 * PR-3 host API surface on ctx.companies
 * (2026-07-18-settings-visibility-and-plugin-enablement-design.md §5.2).
 * The published SDK type does not include it until PR-3 lands, so this is the
 * single cast site in the plugin. Delete the cast when PR-3 merges.
 */
interface CompaniesStandingClient {
  setStanding(companyId: string, input: StandingSetInput): Promise<void>;
  clearStanding(companyId: string): Promise<void>;
}

export function standingWriterFromContext(ctx: PluginContext): StandingWriter {
  const client = ctx.companies as unknown as CompaniesStandingClient;
  return {
    set: (companyId, input) => client.setStanding(companyId, input),
    clear: (companyId) => client.clearStanding(companyId),
  };
}

export async function applyStandingCommand(
  writer: StandingWriter,
  companyId: string,
  command: StandingCommand,
): Promise<void> {
  if (command.kind === "clear") {
    await writer.clear(companyId);
    return;
  }
  await writer.set(companyId, {
    status: command.status,
    reason: command.reason,
    message: command.message,
    ...(command.actionUrl === undefined ? {} : { actionUrl: command.actionUrl }),
  });
}
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/standing.spec.ts` — expect all passing.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/domain.ts packages/plugins/plugin-billing/src/standing.ts packages/plugins/plugin-billing/tests/standing.spec.ts
git commit -m "feat(plugin-billing): domain types and PR-3 standing writer adapter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Pure state machine (the heart)

**Files:**
- Create: `packages/plugins/plugin-billing/src/state-machine.ts`
- Test: `packages/plugins/plugin-billing/tests/state-machine.spec.ts`

**Interfaces:**
- Consumes: `SubscriptionRow`, `BillingEvent`, `StandingCommand` (Task 5), `BillingConfig` (Task 4), `BILLING_PAGE_PATH` (Task 1).
- Produces:

```ts
export interface TransitionEffect { kind: "provider.cancel_now"; providerSubscriptionId: string; }
export interface TransitionResult { sub: SubscriptionRow; changed: boolean; effects: TransitionEffect[]; }
export function transition(sub: SubscriptionRow, event: BillingEvent, config: BillingConfig, now: Date): TransitionResult;
export function expectedStanding(sub: SubscriptionRow, config: BillingConfig): StandingCommand;
export function addDaysIso(iso: string, days: number): string;
```

TDD note: tests FIRST, and they are exhaustive — every status × every event type, plus every clock boundary (before/at/after) and the out-of-order `periodEnd` guard. `transition` is pure: no I/O, no randomness, no `Date.now()`.

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/state-machine.spec.ts` (complete file):

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_BILLING_CONFIG } from "../src/config.js";
import { BILLING_PAGE_PATH } from "../src/constants.js";
import { SUBSCRIPTION_STATUSES, type BillingEvent, type SubscriptionRow, type SubscriptionStatus } from "../src/domain.js";
import { addDaysIso, expectedStanding, transition } from "../src/state-machine.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");
const CONFIG = DEFAULT_BILLING_CONFIG; // trialDays 7, graceDays 7

function mkSub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1",
    companyId: "co-1",
    ownerUserId: "user-1",
    customerId: null,
    status: "awaiting_payment",
    trialEndsAt: null,
    graceSince: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    priceCentsOverride: null,
    providerSubscriptionId: null,
    openCheckoutSessionRef: null,
    openCheckoutUrl: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Representative row per status, with the fields that status implies. */
function subInStatus(status: SubscriptionStatus): SubscriptionRow {
  switch (status) {
    case "trialing":
      return mkSub({ status, trialEndsAt: "2026-07-25T12:00:00.000Z" });
    case "awaiting_payment":
      return mkSub({ status });
    case "active":
      return mkSub({ status, providerSubscriptionId: "psub-1", currentPeriodEnd: "2026-08-17T12:00:00.000Z" });
    case "grace":
      return mkSub({ status, providerSubscriptionId: "psub-1", graceSince: "2026-07-16T12:00:00.000Z" });
    case "blocked":
      return mkSub({ status, providerSubscriptionId: "psub-1", graceSince: "2026-07-01T12:00:00.000Z" });
    case "canceled":
      return mkSub({ status, providerSubscriptionId: "psub-1" });
    case "complimentary":
      return mkSub({ status, priceCentsOverride: 0 });
  }
}

describe("transition — clock boundaries", () => {
  it("trialing stays trialing strictly before trialEndsAt", () => {
    const sub = mkSub({ status: "trialing", trialEndsAt: "2026-07-18T12:00:00.001Z" });
    const r = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(r.changed).toBe(false);
    expect(r.sub.status).toBe("trialing");
  });

  it("trialing → grace exactly at trialEndsAt, graceSince anchored to trialEndsAt (clock-skew safe)", () => {
    const sub = mkSub({ status: "trialing", trialEndsAt: "2026-07-18T12:00:00.000Z" });
    const r = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(r.changed).toBe(true);
    expect(r.sub.status).toBe("grace");
    expect(r.sub.graceSince).toBe("2026-07-18T12:00:00.000Z");
    expect(r.effects).toEqual([]);
  });

  it("trialing far past trialEndsAt still lands in grace first (sweep runs twice to reach blocked)", () => {
    const sub = mkSub({ status: "trialing", trialEndsAt: "2026-06-01T00:00:00.000Z" });
    const first = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(first.sub.status).toBe("grace");
    const second = transition(first.sub, { type: "clock" }, CONFIG, NOW);
    expect(second.sub.status).toBe("blocked");
  });

  it("grace stays grace strictly before graceSince + graceDays", () => {
    const sub = mkSub({ status: "grace", graceSince: addDaysIso(NOW.toISOString(), -CONFIG.graceDays + 1) });
    const r = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(r.changed).toBe(false);
  });

  it("grace → blocked exactly at graceSince + graceDays", () => {
    const sub = mkSub({ status: "grace", graceSince: addDaysIso(NOW.toISOString(), -CONFIG.graceDays) });
    const r = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(r.sub.status).toBe("blocked");
  });

  it("active with cancelAtPeriodEnd → canceled once currentPeriodEnd passes; flag resets", () => {
    const before = mkSub({ status: "active", providerSubscriptionId: "psub-1", cancelAtPeriodEnd: true, currentPeriodEnd: "2026-07-19T00:00:00.000Z" });
    expect(transition(before, { type: "clock" }, CONFIG, NOW).changed).toBe(false);
    const due = mkSub({ status: "active", providerSubscriptionId: "psub-1", cancelAtPeriodEnd: true, currentPeriodEnd: "2026-07-18T12:00:00.000Z" });
    const r = transition(due, { type: "clock" }, CONFIG, NOW);
    expect(r.sub.status).toBe("canceled");
    expect(r.sub.cancelAtPeriodEnd).toBe(false);
  });

  it("active without cancelAtPeriodEnd never clock-cancels, even long past periodEnd (dunning owns it)", () => {
    const sub = mkSub({ status: "active", providerSubscriptionId: "psub-1", currentPeriodEnd: "2026-06-01T00:00:00.000Z" });
    expect(transition(sub, { type: "clock" }, CONFIG, NOW).changed).toBe(false);
  });

  it("clock is a no-op for awaiting_payment, blocked, canceled, complimentary", () => {
    for (const status of ["awaiting_payment", "blocked", "canceled", "complimentary"] as const) {
      const r = transition(subInStatus(status), { type: "clock" }, CONFIG, NOW);
      expect(r.changed, status).toBe(false);
    }
  });
});

describe("transition — checkout.completed / one_click.activated", () => {
  const checkout: BillingEvent = { type: "checkout.completed", sessionRef: "sess-1", subRef: "psub-9", periodEnd: "2026-08-18T12:00:00.000Z" };

  it("activates every unpaid state and clears checkout/grace bookkeeping", () => {
    for (const status of ["trialing", "awaiting_payment", "grace", "blocked", "canceled"] as const) {
      const sub = { ...subInStatus(status), openCheckoutSessionRef: "sess-1", openCheckoutUrl: "billing-checkout?session=sess-1" };
      const r = transition(sub, checkout, CONFIG, NOW);
      expect(r.sub.status, status).toBe("active");
      expect(r.sub.providerSubscriptionId).toBe("psub-9");
      expect(r.sub.currentPeriodEnd).toBe("2026-08-18T12:00:00.000Z");
      expect(r.sub.openCheckoutSessionRef).toBeNull();
      expect(r.sub.openCheckoutUrl).toBeNull();
      expect(r.sub.cancelAtPeriodEnd).toBe(false);
      expect(r.sub.graceSince).toBeNull();
      expect(r.changed).toBe(true);
    }
  });

  it("subscribe-during-trial keeps trialEndsAt for display", () => {
    const sub = subInStatus("trialing");
    const r = transition(sub, checkout, CONFIG, NOW);
    expect(r.sub.status).toBe("active");
    expect(r.sub.trialEndsAt).toBe(sub.trialEndsAt);
  });

  it("is idempotent and out-of-order safe on active (periodEnd only ever grows)", () => {
    const sub = mkSub({ status: "active", providerSubscriptionId: "psub-9", currentPeriodEnd: "2026-09-01T00:00:00.000Z" });
    const r = transition(sub, checkout, CONFIG, NOW);
    expect(r.sub.currentPeriodEnd).toBe("2026-09-01T00:00:00.000Z");
    expect(r.changed).toBe(false);
  });

  it("never touches complimentary", () => {
    const r = transition(subInStatus("complimentary"), checkout, CONFIG, NOW);
    expect(r.changed).toBe(false);
  });

  it("one_click.activated behaves like checkout.completed and tolerates a null subRef", () => {
    const r = transition(subInStatus("awaiting_payment"), { type: "one_click.activated", subRef: null, periodEnd: "2026-08-18T12:00:00.000Z" }, CONFIG, NOW);
    expect(r.sub.status).toBe("active");
    expect(r.sub.providerSubscriptionId).toBeNull();
  });
});

describe("transition — payment.succeeded", () => {
  const paid: BillingEvent = { type: "payment.succeeded", subRef: "psub-1", periodEnd: "2026-09-17T12:00:00.000Z" };

  it("extends the period on active and adopts subRef when missing", () => {
    const sub = mkSub({ status: "active", providerSubscriptionId: null, currentPeriodEnd: "2026-08-17T12:00:00.000Z" });
    const r = transition(sub, paid, CONFIG, NOW);
    expect(r.sub.currentPeriodEnd).toBe("2026-09-17T12:00:00.000Z");
    expect(r.sub.providerSubscriptionId).toBe("psub-1");
  });

  it("out-of-order renewal never shrinks the period", () => {
    const sub = mkSub({ status: "active", providerSubscriptionId: "psub-1", currentPeriodEnd: "2026-10-17T12:00:00.000Z" });
    const r = transition(sub, paid, CONFIG, NOW);
    expect(r.sub.currentPeriodEnd).toBe("2026-10-17T12:00:00.000Z");
    expect(r.changed).toBe(false);
  });

  it("auto-unblocks grace and blocked, revives canceled, activates trialing/awaiting_payment", () => {
    for (const status of ["grace", "blocked", "canceled", "trialing", "awaiting_payment"] as const) {
      const r = transition(subInStatus(status), paid, CONFIG, NOW);
      expect(r.sub.status, status).toBe("active");
      expect(r.sub.graceSince).toBeNull();
    }
  });

  it("never touches complimentary", () => {
    expect(transition(subInStatus("complimentary"), paid, CONFIG, NOW).changed).toBe(false);
  });
});

describe("transition — payment.failed", () => {
  const failed: BillingEvent = { type: "payment.failed", subRef: "psub-1" };

  it("active → grace with graceSince = now", () => {
    const r = transition(subInStatus("active"), failed, CONFIG, NOW);
    expect(r.sub.status).toBe("grace");
    expect(r.sub.graceSince).toBe(NOW.toISOString());
  });

  it("repeat failures during grace do not extend the grace window", () => {
    const sub = subInStatus("grace");
    const r = transition(sub, failed, CONFIG, NOW);
    expect(r.changed).toBe(false);
    expect(r.sub.graceSince).toBe(sub.graceSince);
  });

  it("is a no-op for every non-active, non-grace status", () => {
    for (const status of ["trialing", "awaiting_payment", "blocked", "canceled", "complimentary"] as const) {
      expect(transition(subInStatus(status), failed, CONFIG, NOW).changed, status).toBe(false);
    }
  });
});

describe("transition — subscription.canceled", () => {
  const canceled: BillingEvent = { type: "subscription.canceled", subRef: "psub-1" };

  it("cancels active/grace/blocked/trialing/awaiting_payment", () => {
    for (const status of ["active", "grace", "blocked", "trialing", "awaiting_payment"] as const) {
      const r = transition(subInStatus(status), canceled, CONFIG, NOW);
      expect(r.sub.status, status).toBe("canceled");
      expect(r.sub.cancelAtPeriodEnd).toBe(false);
    }
  });

  it("is a no-op for canceled and complimentary", () => {
    for (const status of ["canceled", "complimentary"] as const) {
      expect(transition(subInStatus(status), canceled, CONFIG, NOW).changed, status).toBe(false);
    }
  });
});

describe("transition — owner cancel/resume", () => {
  it("cancel_at_period_end only flips the flag on active", () => {
    const r = transition(subInStatus("active"), { type: "owner.cancel_at_period_end" }, CONFIG, NOW);
    expect(r.sub.status).toBe("active");
    expect(r.sub.cancelAtPeriodEnd).toBe(true);
    for (const status of ["trialing", "awaiting_payment", "grace", "blocked", "canceled", "complimentary"] as const) {
      expect(transition(subInStatus(status), { type: "owner.cancel_at_period_end" }, CONFIG, NOW).changed, status).toBe(false);
    }
  });

  it("resume clears the flag on active only", () => {
    const sub = { ...subInStatus("active"), cancelAtPeriodEnd: true };
    const r = transition(sub, { type: "owner.resume" }, CONFIG, NOW);
    expect(r.sub.cancelAtPeriodEnd).toBe(false);
    for (const status of ["trialing", "awaiting_payment", "grace", "blocked", "canceled", "complimentary"] as const) {
      expect(transition(subInStatus(status), { type: "owner.resume" }, CONFIG, NOW).changed, status).toBe(false);
    }
  });
});

describe("transition — admin.set_price_override", () => {
  it("0 comps the company from any status and cancels any live provider subscription", () => {
    for (const status of SUBSCRIPTION_STATUSES.filter((s) => s !== "complimentary")) {
      const sub = subInStatus(status);
      const r = transition(sub, { type: "admin.set_price_override", priceCents: 0 }, CONFIG, NOW);
      expect(r.sub.status, status).toBe("complimentary");
      expect(r.sub.priceCentsOverride).toBe(0);
      expect(r.sub.providerSubscriptionId).toBeNull();
      expect(r.sub.openCheckoutSessionRef).toBeNull();
      if (sub.providerSubscriptionId) {
        expect(r.effects).toEqual([{ kind: "provider.cancel_now", providerSubscriptionId: sub.providerSubscriptionId }]);
      } else {
        expect(r.effects).toEqual([]);
      }
    }
  });

  it("a positive override only changes the price for non-complimentary statuses", () => {
    const sub = subInStatus("active");
    const r = transition(sub, { type: "admin.set_price_override", priceCents: 9900 }, CONFIG, NOW);
    expect(r.sub.status).toBe("active");
    expect(r.sub.priceCentsOverride).toBe(9900);
  });

  it("leaving complimentary (override → null or > 0) lands in awaiting_payment", () => {
    for (const priceCents of [null, 9900]) {
      const r = transition(subInStatus("complimentary"), { type: "admin.set_price_override", priceCents }, CONFIG, NOW);
      expect(r.sub.status).toBe("awaiting_payment");
      expect(r.sub.priceCentsOverride).toBe(priceCents);
    }
  });
});

describe("transition — admin.extend_trial", () => {
  const extend: BillingEvent = { type: "admin.extend_trial", trialEndsAt: "2026-08-01T00:00:00.000Z" };

  it("extends trialing and revives trial-origin grace/blocked and awaiting_payment into trialing", () => {
    for (const status of ["trialing", "awaiting_payment"] as const) {
      const r = transition(subInStatus(status), extend, CONFIG, NOW);
      expect(r.sub.status, status).toBe("trialing");
      expect(r.sub.trialEndsAt).toBe("2026-08-01T00:00:00.000Z");
    }
    for (const status of ["grace", "blocked"] as const) {
      const trialOrigin = { ...subInStatus(status), providerSubscriptionId: null };
      const r = transition(trialOrigin, extend, CONFIG, NOW);
      expect(r.sub.status, status).toBe("trialing");
      expect(r.sub.graceSince).toBeNull();
    }
  });

  it("does not touch paid grace/blocked, active, canceled, complimentary", () => {
    for (const status of ["grace", "blocked"] as const) {
      expect(transition(subInStatus(status), extend, CONFIG, NOW).changed, `paid ${status}`).toBe(false);
    }
    for (const status of ["active", "canceled", "complimentary"] as const) {
      expect(transition(subInStatus(status), extend, CONFIG, NOW).changed, status).toBe(false);
    }
  });
});

describe("transition — company.deleted", () => {
  it("cancels locally and emits a provider cancel effect when a provider subscription exists", () => {
    for (const status of ["active", "grace", "blocked"] as const) {
      const sub = subInStatus(status);
      const r = transition(sub, { type: "company.deleted" }, CONFIG, NOW);
      expect(r.sub.status).toBe("canceled");
      expect(r.effects).toEqual([{ kind: "provider.cancel_now", providerSubscriptionId: "psub-1" }]);
    }
  });

  it("cancels without effect when no provider subscription exists", () => {
    for (const status of ["trialing", "awaiting_payment", "complimentary"] as const) {
      const r = transition(subInStatus(status), { type: "company.deleted" }, CONFIG, NOW);
      expect(r.sub.status, status).toBe("canceled");
      expect(r.effects).toEqual([]);
    }
  });

  it("is a no-op when already canceled", () => {
    expect(transition(subInStatus("canceled"), { type: "company.deleted" }, CONFIG, NOW).changed).toBe(false);
  });
});

describe("transition — purity and updatedAt", () => {
  it("never mutates its input and stamps updatedAt only on change", () => {
    const sub = subInStatus("active");
    const frozen = JSON.stringify(sub);
    const changed = transition(sub, { type: "owner.cancel_at_period_end" }, CONFIG, NOW);
    const unchanged = transition(sub, { type: "clock" }, CONFIG, NOW);
    expect(JSON.stringify(sub)).toBe(frozen);
    expect(changed.sub.updatedAt).toBe(NOW.toISOString());
    expect(unchanged.sub.updatedAt).toBe(sub.updatedAt);
  });
});

describe("expectedStanding — full status mapping", () => {
  it("active and complimentary clear standing", () => {
    expect(expectedStanding(subInStatus("active"), CONFIG)).toEqual({ kind: "clear" });
    expect(expectedStanding(subInStatus("complimentary"), CONFIG)).toEqual({ kind: "clear" });
  });

  it("trialing writes an informational active standing with the trial deadline", () => {
    expect(expectedStanding(subInStatus("trialing"), CONFIG)).toEqual({
      kind: "set",
      status: "active",
      reason: "trialing",
      message: "Free trial — ends 2026-07-25.",
      actionUrl: BILLING_PAGE_PATH,
    });
  });

  it("awaiting_payment blocks with awaiting_subscription", () => {
    expect(expectedStanding(subInStatus("awaiting_payment"), CONFIG)).toEqual({
      kind: "set",
      status: "blocked",
      reason: "awaiting_subscription",
      message: "This company needs a subscription before agents can run.",
      actionUrl: BILLING_PAGE_PATH,
    });
  });

  it("grace distinguishes trial_ended (no provider sub) from payment_past_due and includes the deadline", () => {
    const paidGrace = subInStatus("grace"); // graceSince 2026-07-16, graceDays 7 → deadline 2026-07-23
    expect(expectedStanding(paidGrace, CONFIG)).toEqual({
      kind: "set",
      status: "grace",
      reason: "payment_past_due",
      message: "Payment failed — the provider will retry. Fix payment by 2026-07-23 to keep agents running.",
      actionUrl: BILLING_PAGE_PATH,
    });
    const trialGrace = { ...paidGrace, providerSubscriptionId: null };
    expect(expectedStanding(trialGrace, CONFIG)).toEqual({
      kind: "set",
      status: "grace",
      reason: "trial_ended",
      message: "Trial ended — subscribe by 2026-07-23 to keep agents running.",
      actionUrl: BILLING_PAGE_PATH,
    });
  });

  it("blocked distinguishes trial_ended from payment_failed", () => {
    expect(expectedStanding(subInStatus("blocked"), CONFIG)).toEqual({
      kind: "set",
      status: "blocked",
      reason: "payment_failed",
      message: "Agent runs are paused until this company has an active subscription.",
      actionUrl: BILLING_PAGE_PATH,
    });
    expect(expectedStanding({ ...subInStatus("blocked"), providerSubscriptionId: null }, CONFIG)).toEqual({
      kind: "set",
      status: "blocked",
      reason: "trial_ended",
      message: "Agent runs are paused until this company has an active subscription.",
      actionUrl: BILLING_PAGE_PATH,
    });
  });

  it("canceled blocks with subscription_ended", () => {
    expect(expectedStanding(subInStatus("canceled"), CONFIG)).toEqual({
      kind: "set",
      status: "blocked",
      reason: "subscription_ended",
      message: "The subscription ended. Resubscribe to start new agent runs.",
      actionUrl: BILLING_PAGE_PATH,
    });
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/state-machine.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/state-machine.ts`:

```ts
import type { BillingConfig } from "./config.js";
import { BILLING_PAGE_PATH } from "./constants.js";
import type { BillingEvent, StandingCommand, SubscriptionRow } from "./domain.js";

export interface TransitionEffect {
  kind: "provider.cancel_now";
  providerSubscriptionId: string;
}

export interface TransitionResult {
  sub: SubscriptionRow;
  changed: boolean;
  effects: TransitionEffect[];
}

const MS_PER_DAY = 86_400_000;

export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * MS_PER_DAY).toISOString();
}

function fmtDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "soon";
}

/** Out-of-order guard: a period end may only ever grow. */
function laterIso(current: string | null, incoming: string): string {
  if (current === null) return incoming;
  return Date.parse(incoming) > Date.parse(current) ? incoming : current;
}

function rowsEqual(a: SubscriptionRow, b: SubscriptionRow): boolean {
  return (
    a.status === b.status
    && a.customerId === b.customerId
    && a.trialEndsAt === b.trialEndsAt
    && a.graceSince === b.graceSince
    && a.currentPeriodEnd === b.currentPeriodEnd
    && a.cancelAtPeriodEnd === b.cancelAtPeriodEnd
    && a.priceCentsOverride === b.priceCentsOverride
    && a.providerSubscriptionId === b.providerSubscriptionId
    && a.openCheckoutSessionRef === b.openCheckoutSessionRef
    && a.openCheckoutUrl === b.openCheckoutUrl
  );
}

/**
 * The single pure transition function for the subscription lifecycle
 * (spec §6.2). All time-based transitions are pure functions of `now`;
 * nothing here reads a clock, the DB, or the network.
 */
export function transition(
  sub: SubscriptionRow,
  event: BillingEvent,
  config: BillingConfig,
  now: Date,
): TransitionResult {
  const next: SubscriptionRow = { ...sub };
  const effects: TransitionEffect[] = [];

  switch (event.type) {
    case "clock": {
      if (next.status === "trialing" && next.trialEndsAt !== null
        && Date.parse(next.trialEndsAt) <= now.getTime()) {
        next.status = "grace";
        next.graceSince = next.trialEndsAt;
      } else if (next.status === "grace" && next.graceSince !== null
        && Date.parse(next.graceSince) + config.graceDays * MS_PER_DAY <= now.getTime()) {
        next.status = "blocked";
      } else if (next.status === "active" && next.cancelAtPeriodEnd
        && next.currentPeriodEnd !== null
        && Date.parse(next.currentPeriodEnd) <= now.getTime()) {
        next.status = "canceled";
        next.cancelAtPeriodEnd = false;
      }
      break;
    }

    case "checkout.completed":
    case "one_click.activated": {
      if (next.status === "complimentary") break;
      next.status = "active";
      if (event.subRef !== null && event.subRef !== undefined) {
        next.providerSubscriptionId = event.subRef;
      }
      next.currentPeriodEnd = laterIso(next.currentPeriodEnd, event.periodEnd);
      next.openCheckoutSessionRef = null;
      next.openCheckoutUrl = null;
      next.cancelAtPeriodEnd = false;
      next.graceSince = null;
      break;
    }

    case "payment.succeeded": {
      if (next.status === "complimentary") break;
      next.status = "active";
      next.providerSubscriptionId = next.providerSubscriptionId ?? event.subRef;
      next.currentPeriodEnd = laterIso(next.currentPeriodEnd, event.periodEnd);
      next.graceSince = null;
      break;
    }

    case "payment.failed": {
      if (next.status === "active") {
        next.status = "grace";
        next.graceSince = now.toISOString();
      }
      break;
    }

    case "subscription.canceled": {
      if (next.status === "complimentary" || next.status === "canceled") break;
      next.status = "canceled";
      next.cancelAtPeriodEnd = false;
      next.graceSince = null;
      break;
    }

    case "owner.cancel_at_period_end": {
      if (next.status === "active") next.cancelAtPeriodEnd = true;
      break;
    }

    case "owner.resume": {
      if (next.status === "active") next.cancelAtPeriodEnd = false;
      break;
    }

    case "admin.set_price_override": {
      next.priceCentsOverride = event.priceCents;
      if (event.priceCents === 0) {
        if (next.providerSubscriptionId !== null) {
          effects.push({ kind: "provider.cancel_now", providerSubscriptionId: next.providerSubscriptionId });
          next.providerSubscriptionId = null;
        }
        next.status = "complimentary";
        next.cancelAtPeriodEnd = false;
        next.graceSince = null;
        next.openCheckoutSessionRef = null;
        next.openCheckoutUrl = null;
      } else if (sub.status === "complimentary") {
        next.status = "awaiting_payment";
      }
      break;
    }

    case "admin.extend_trial": {
      const trialOrigin = next.providerSubscriptionId === null;
      const eligible = next.status === "trialing"
        || next.status === "awaiting_payment"
        || ((next.status === "grace" || next.status === "blocked") && trialOrigin);
      if (eligible) {
        next.status = "trialing";
        next.trialEndsAt = event.trialEndsAt;
        next.graceSince = null;
      }
      break;
    }

    case "company.deleted": {
      if (next.status === "canceled") break;
      if (next.providerSubscriptionId !== null) {
        effects.push({ kind: "provider.cancel_now", providerSubscriptionId: next.providerSubscriptionId });
      }
      next.status = "canceled";
      next.cancelAtPeriodEnd = false;
      break;
    }
  }

  const changed = !rowsEqual(sub, next) || effects.length > 0;
  if (changed) next.updatedAt = now.toISOString();
  return { sub: next, changed, effects };
}

/**
 * The one place that maps subscription status to a PR-3 standing command.
 * Idempotent by design: the sweep re-applies it every run so standing always
 * converges to subscription state (spec §8).
 */
export function expectedStanding(sub: SubscriptionRow, config: BillingConfig): StandingCommand {
  switch (sub.status) {
    case "active":
    case "complimentary":
      return { kind: "clear" };
    case "trialing":
      return {
        kind: "set",
        status: "active",
        reason: "trialing",
        message: `Free trial — ends ${fmtDay(sub.trialEndsAt)}.`,
        actionUrl: BILLING_PAGE_PATH,
      };
    case "awaiting_payment":
      return {
        kind: "set",
        status: "blocked",
        reason: "awaiting_subscription",
        message: "This company needs a subscription before agents can run.",
        actionUrl: BILLING_PAGE_PATH,
      };
    case "grace": {
      const deadline = sub.graceSince ? fmtDay(addDaysIso(sub.graceSince, config.graceDays)) : "soon";
      if (sub.providerSubscriptionId === null) {
        return {
          kind: "set",
          status: "grace",
          reason: "trial_ended",
          message: `Trial ended — subscribe by ${deadline} to keep agents running.`,
          actionUrl: BILLING_PAGE_PATH,
        };
      }
      return {
        kind: "set",
        status: "grace",
        reason: "payment_past_due",
        message: `Payment failed — the provider will retry. Fix payment by ${deadline} to keep agents running.`,
        actionUrl: BILLING_PAGE_PATH,
      };
    }
    case "blocked":
      return {
        kind: "set",
        status: "blocked",
        reason: sub.providerSubscriptionId === null ? "trial_ended" : "payment_failed",
        message: "Agent runs are paused until this company has an active subscription.",
        actionUrl: BILLING_PAGE_PATH,
      };
    case "canceled":
      return {
        kind: "set",
        status: "blocked",
        reason: "subscription_ended",
        message: "The subscription ended. Resubscribe to start new agent runs.",
        actionUrl: BILLING_PAGE_PATH,
      };
  }
}
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/state-machine.spec.ts` — expect all passing (every status × event combination asserted).
- [ ] Run `pnpm --filter @paperclipai/plugin-billing typecheck`.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/state-machine.ts packages/plugins/plugin-billing/tests/state-machine.spec.ts
git commit -m "feat(plugin-billing): pure subscription state machine with exhaustive table tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 7: BillingStore port + in-memory adapter

**Files:**
- Create: `packages/plugins/plugin-billing/src/store.ts`
- Create: `packages/plugins/plugin-billing/src/store-memory.ts`
- Test: `packages/plugins/plugin-billing/tests/store-memory.spec.ts`

**Interfaces:**
- Consumes: domain types (Task 5).
- Produces:

```ts
export interface BillingStore {
  getSubscriptionByCompany(companyId: string): Promise<SubscriptionRow | null>;
  getSubscriptionByProviderRef(subRef: string): Promise<SubscriptionRow | null>;
  getSubscriptionBySessionRef(sessionRef: string): Promise<SubscriptionRow | null>;
  listSubscriptions(): Promise<SubscriptionRow[]>;
  insertSubscription(sub: SubscriptionRow): Promise<void>;
  updateSubscription(sub: SubscriptionRow): Promise<void>;
  getCustomerByUser(provider: string, userId: string): Promise<CustomerRow | null>;
  upsertCustomer(customer: CustomerRow): Promise<void>;
  insertLedgerEvent(event: LedgerInsert): Promise<"inserted" | "duplicate">;
  markLedgerApplied(ledgerId: string, appliedAtIso: string): Promise<void>;
  listUnappliedLedgerEvents(limit: number): Promise<LedgerRow[]>;
  listLedgerEventsForCompany(companyId: string, limit: number): Promise<LedgerRow[]>;
  ownerHadTrial(ownerUserId: string): Promise<boolean>;
}
export class MemoryBillingStore implements BillingStore { /* + nowFn constructor arg for deterministic createdAt */ }
```

The harness's `ctx.db` is a recorder that returns `[]` (`packages/plugins/sdk/src/testing.ts:858-869`), so all behavioral tests in later tasks run against `MemoryBillingStore`; `SqlBillingStore` (Task 8) is tested by asserting the SQL it emits.

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/store-memory.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SubscriptionRow } from "../src/domain.js";
import { MemoryBillingStore } from "../src/store-memory.js";

function mkSub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1",
    companyId: "co-1",
    ownerUserId: "user-1",
    customerId: null,
    status: "awaiting_payment",
    trialEndsAt: null,
    graceSince: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    priceCentsOverride: null,
    providerSubscriptionId: null,
    openCheckoutSessionRef: null,
    openCheckoutUrl: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MemoryBillingStore", () => {
  it("round-trips subscriptions by company, provider ref, and session ref", async () => {
    const store = new MemoryBillingStore();
    await store.insertSubscription(mkSub({ providerSubscriptionId: "psub-1", openCheckoutSessionRef: "sess-1" }));
    expect(await store.getSubscriptionByCompany("co-1")).toMatchObject({ id: "sub-1" });
    expect(await store.getSubscriptionByProviderRef("psub-1")).toMatchObject({ id: "sub-1" });
    expect(await store.getSubscriptionBySessionRef("sess-1")).toMatchObject({ id: "sub-1" });
    expect(await store.getSubscriptionByCompany("co-x")).toBeNull();
    expect(await store.getSubscriptionByProviderRef("psub-x")).toBeNull();
    expect(await store.getSubscriptionBySessionRef("sess-x")).toBeNull();
  });

  it("updateSubscription replaces the stored row and re-indexes refs", async () => {
    const store = new MemoryBillingStore();
    await store.insertSubscription(mkSub());
    await store.updateSubscription(mkSub({ status: "active", providerSubscriptionId: "psub-9" }));
    expect((await store.getSubscriptionByCompany("co-1"))?.status).toBe("active");
    expect(await store.getSubscriptionByProviderRef("psub-9")).not.toBeNull();
  });

  it("returned rows are copies (mutating them does not corrupt the store)", async () => {
    const store = new MemoryBillingStore();
    await store.insertSubscription(mkSub());
    const row = await store.getSubscriptionByCompany("co-1");
    row!.status = "canceled";
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("awaiting_payment");
  });

  it("upserts customers keyed by (provider, userId)", async () => {
    const store = new MemoryBillingStore();
    await store.upsertCustomer({ id: "cust-1", userId: "user-1", provider: "stub", providerCustomerId: "sc-1", hasDefaultPaymentMethod: false });
    await store.upsertCustomer({ id: "cust-1", userId: "user-1", provider: "stub", providerCustomerId: "sc-1", hasDefaultPaymentMethod: true });
    const customer = await store.getCustomerByUser("stub", "user-1");
    expect(customer).toMatchObject({ id: "cust-1", hasDefaultPaymentMethod: true });
    expect(await store.getCustomerByUser("stub", "user-2")).toBeNull();
  });

  it("insertLedgerEvent is idempotent on idempotencyKey", async () => {
    const store = new MemoryBillingStore();
    const event = { id: "ev-1", idempotencyKey: "key-1", type: "payment.succeeded", subscriptionId: "sub-1", companyId: "co-1", rawPayload: { a: 1 } };
    expect(await store.insertLedgerEvent(event)).toBe("inserted");
    expect(await store.insertLedgerEvent({ ...event, id: "ev-2" })).toBe("duplicate");
    expect(await store.listUnappliedLedgerEvents(10)).toHaveLength(1);
  });

  it("markLedgerApplied removes the row from the unapplied list", async () => {
    const store = new MemoryBillingStore();
    await store.insertLedgerEvent({ id: "ev-1", idempotencyKey: "key-1", type: "clock", subscriptionId: null, companyId: null, rawPayload: {} });
    await store.markLedgerApplied("ev-1", "2026-07-18T12:00:00.000Z");
    expect(await store.listUnappliedLedgerEvents(10)).toEqual([]);
  });

  it("lists company ledger events newest-first with limit", async () => {
    const store = new MemoryBillingStore(() => new Date("2026-07-18T12:00:00.000Z"));
    for (let i = 0; i < 3; i += 1) {
      await store.insertLedgerEvent({ id: `ev-${i}`, idempotencyKey: `key-${i}`, type: "t", subscriptionId: null, companyId: "co-1", rawPayload: { i } });
    }
    const events = await store.listLedgerEventsForCompany("co-1", 2);
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe("ev-2");
  });

  it("ownerHadTrial matches trial.started ledger rows by rawPayload.ownerUserId — surviving company deletion", async () => {
    const store = new MemoryBillingStore();
    await store.insertLedgerEvent({ id: "ev-1", idempotencyKey: "trial-started:co-1", type: "trial.started", subscriptionId: "sub-1", companyId: "co-1", rawPayload: { ownerUserId: "user-1", companyId: "co-1" } });
    expect(await store.ownerHadTrial("user-1")).toBe(true);
    expect(await store.ownerHadTrial("user-2")).toBe(false);
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/store-memory.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/store.ts`:

```ts
import type { CustomerRow, LedgerInsert, LedgerRow, SubscriptionRow } from "./domain.js";

/**
 * Persistence port. Two adapters:
 * - SqlBillingStore (ctx.db, plugin namespace) in production,
 * - MemoryBillingStore in tests (the SDK test harness's ctx.db is a recorder).
 */
export interface BillingStore {
  getSubscriptionByCompany(companyId: string): Promise<SubscriptionRow | null>;
  getSubscriptionByProviderRef(subRef: string): Promise<SubscriptionRow | null>;
  getSubscriptionBySessionRef(sessionRef: string): Promise<SubscriptionRow | null>;
  listSubscriptions(): Promise<SubscriptionRow[]>;
  insertSubscription(sub: SubscriptionRow): Promise<void>;
  updateSubscription(sub: SubscriptionRow): Promise<void>;
  getCustomerByUser(provider: string, userId: string): Promise<CustomerRow | null>;
  upsertCustomer(customer: CustomerRow): Promise<void>;
  /** Unique idempotency_key makes replays no-ops: returns "duplicate" instead of throwing. */
  insertLedgerEvent(event: LedgerInsert): Promise<"inserted" | "duplicate">;
  markLedgerApplied(ledgerId: string, appliedAtIso: string): Promise<void>;
  listUnappliedLedgerEvents(limit: number): Promise<LedgerRow[]>;
  listLedgerEventsForCompany(companyId: string, limit: number): Promise<LedgerRow[]>;
  /** Trial eligibility: has this owner EVER had a trial (ledger-based, survives company deletion). */
  ownerHadTrial(ownerUserId: string): Promise<boolean>;
}
```

- [ ] Create `packages/plugins/plugin-billing/src/store-memory.ts`:

```ts
import type { CustomerRow, LedgerInsert, LedgerRow, SubscriptionRow } from "./domain.js";
import type { BillingStore } from "./store.js";

export class MemoryBillingStore implements BillingStore {
  private subscriptions = new Map<string, SubscriptionRow>(); // by companyId
  private customers = new Map<string, CustomerRow>(); // by `${provider}:${userId}`
  private ledger: LedgerRow[] = [];
  private ledgerKeys = new Set<string>();

  constructor(private readonly nowFn: () => Date = () => new Date()) {}

  async getSubscriptionByCompany(companyId: string): Promise<SubscriptionRow | null> {
    const row = this.subscriptions.get(companyId);
    return row ? { ...row } : null;
  }

  async getSubscriptionByProviderRef(subRef: string): Promise<SubscriptionRow | null> {
    for (const row of this.subscriptions.values()) {
      if (row.providerSubscriptionId === subRef) return { ...row };
    }
    return null;
  }

  async getSubscriptionBySessionRef(sessionRef: string): Promise<SubscriptionRow | null> {
    for (const row of this.subscriptions.values()) {
      if (row.openCheckoutSessionRef === sessionRef) return { ...row };
    }
    return null;
  }

  async listSubscriptions(): Promise<SubscriptionRow[]> {
    return [...this.subscriptions.values()].map((row) => ({ ...row }));
  }

  async insertSubscription(sub: SubscriptionRow): Promise<void> {
    if (this.subscriptions.has(sub.companyId)) {
      throw new Error(`duplicate subscription for company ${sub.companyId}`);
    }
    this.subscriptions.set(sub.companyId, { ...sub });
  }

  async updateSubscription(sub: SubscriptionRow): Promise<void> {
    this.subscriptions.set(sub.companyId, { ...sub });
  }

  async getCustomerByUser(provider: string, userId: string): Promise<CustomerRow | null> {
    const row = this.customers.get(`${provider}:${userId}`);
    return row ? { ...row } : null;
  }

  async upsertCustomer(customer: CustomerRow): Promise<void> {
    this.customers.set(`${customer.provider}:${customer.userId}`, { ...customer });
  }

  async insertLedgerEvent(event: LedgerInsert): Promise<"inserted" | "duplicate"> {
    if (this.ledgerKeys.has(event.idempotencyKey)) return "duplicate";
    this.ledgerKeys.add(event.idempotencyKey);
    this.ledger.push({ ...event, appliedAt: null, createdAt: this.nowFn().toISOString() });
    return "inserted";
  }

  async markLedgerApplied(ledgerId: string, appliedAtIso: string): Promise<void> {
    const row = this.ledger.find((entry) => entry.id === ledgerId);
    if (row) row.appliedAt = appliedAtIso;
  }

  async listUnappliedLedgerEvents(limit: number): Promise<LedgerRow[]> {
    return this.ledger.filter((entry) => entry.appliedAt === null).slice(0, limit).map((entry) => ({ ...entry }));
  }

  async listLedgerEventsForCompany(companyId: string, limit: number): Promise<LedgerRow[]> {
    return [...this.ledger]
      .filter((entry) => entry.companyId === companyId)
      .reverse()
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  async ownerHadTrial(ownerUserId: string): Promise<boolean> {
    return this.ledger.some(
      (entry) => entry.type === "trial.started" && entry.rawPayload.ownerUserId === ownerUserId,
    );
  }
}
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/store-memory.spec.ts` — expect all passing.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/store.ts packages/plugins/plugin-billing/src/store-memory.ts packages/plugins/plugin-billing/tests/store-memory.spec.ts
git commit -m "feat(plugin-billing): BillingStore port with in-memory adapter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: SQL store adapter

**Files:**
- Create: `packages/plugins/plugin-billing/src/store-sql.ts`
- Test: `packages/plugins/plugin-billing/tests/store-sql.spec.ts`

**Interfaces:**
- Consumes: `PluginDatabaseClient` (`ctx.db` — `query<T>(sql, params)`, `execute(sql, params)`; `packages/plugins/sdk/src/types.ts:609-618`). Runtime SQL must target only `plugin_billing_d8ffbbf605.*` (host validator: `validatePluginRuntimeQuery`/`validatePluginRuntimeExecute` in `server/src/services/plugin-database.ts`) plus declared core read table `public.companies` (unused here — the worker reads companies via `ctx.companies`).
- Produces: `class SqlBillingStore implements BillingStore { constructor(db: PluginDatabaseClient) }`.

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/store-sql.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { DB_NAMESPACE } from "../src/constants.js";
import { SqlBillingStore } from "../src/store-sql.js";

interface Recorded { sql: string; params?: unknown[]; }

function fakeDb(options: { rows?: Record<string, unknown>[]; rowCount?: number } = {}) {
  const queries: Recorded[] = [];
  const executes: Recorded[] = [];
  const db: PluginDatabaseClient = {
    namespace: DB_NAMESPACE,
    async query(sql, params) {
      queries.push({ sql, params });
      return (options.rows ?? []) as never[];
    },
    async execute(sql, params) {
      executes.push({ sql, params });
      return { rowCount: options.rowCount ?? 1 };
    },
  };
  return { db, queries, executes };
}

const DB_SUB_ROW = {
  id: "sub-1",
  company_id: "co-1",
  owner_user_id: "user-1",
  customer_id: null,
  status: "trialing",
  trial_ends_at: "2026-07-25T12:00:00.000Z",
  grace_since: null,
  current_period_end: null,
  cancel_at_period_end: false,
  price_cents_override: null,
  provider_subscription_id: null,
  open_checkout_session_ref: null,
  open_checkout_url: null,
  created_at: "2026-07-18T00:00:00.000Z",
  updated_at: "2026-07-18T00:00:00.000Z",
};

describe("SqlBillingStore", () => {
  it("maps a snake_case subscription row to the domain shape", async () => {
    const { db } = fakeDb({ rows: [DB_SUB_ROW] });
    const sub = await new SqlBillingStore(db).getSubscriptionByCompany("co-1");
    expect(sub).toEqual({
      id: "sub-1",
      companyId: "co-1",
      ownerUserId: "user-1",
      customerId: null,
      status: "trialing",
      trialEndsAt: "2026-07-25T12:00:00.000Z",
      graceSince: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      priceCentsOverride: null,
      providerSubscriptionId: null,
      openCheckoutSessionRef: null,
      openCheckoutUrl: null,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
  });

  it("every query and execute is namespace-qualified and parameterized", async () => {
    const { db, queries, executes } = fakeDb({ rows: [] });
    const store = new SqlBillingStore(db);
    await store.getSubscriptionByCompany("co-1");
    await store.getSubscriptionByProviderRef("psub-1");
    await store.getSubscriptionBySessionRef("sess-1");
    await store.listSubscriptions();
    await store.getCustomerByUser("stub", "user-1");
    await store.listUnappliedLedgerEvents(50);
    await store.listLedgerEventsForCompany("co-1", 20);
    await store.ownerHadTrial("user-1");
    await store.markLedgerApplied("ev-1", "2026-07-18T12:00:00.000Z");
    for (const recorded of [...queries, ...executes]) {
      expect(recorded.sql).toContain(`${DB_NAMESPACE}.`);
      expect(recorded.sql).not.toMatch(/'\$\{|" \+ /); // no string interpolation of values
    }
    const byCompany = queries[0];
    expect(byCompany.sql).toContain("WHERE company_id = $1");
    expect(byCompany.params).toEqual(["co-1"]);
  });

  it("insertLedgerEvent uses ON CONFLICT DO NOTHING and reports duplicate on rowCount 0", async () => {
    const inserted = fakeDb({ rowCount: 1 });
    const dup = fakeDb({ rowCount: 0 });
    const event = { id: "ev-1", idempotencyKey: "k", type: "t", subscriptionId: null, companyId: null, rawPayload: { a: 1 } };
    expect(await new SqlBillingStore(inserted.db).insertLedgerEvent(event)).toBe("inserted");
    expect(await new SqlBillingStore(dup.db).insertLedgerEvent(event)).toBe("duplicate");
    expect(inserted.executes[0].sql).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(inserted.executes[0].params?.[5]).toBe(JSON.stringify({ a: 1 }));
  });

  it("upsertCustomer conflicts on (provider, user_id)", async () => {
    const { db, executes } = fakeDb();
    await new SqlBillingStore(db).upsertCustomer({ id: "cust-1", userId: "user-1", provider: "stub", providerCustomerId: "sc-1", hasDefaultPaymentMethod: true });
    expect(executes[0].sql).toContain("ON CONFLICT (provider, user_id) DO UPDATE");
  });

  it("insert and update write all subscription columns", async () => {
    const { db, executes } = fakeDb();
    const store = new SqlBillingStore(db);
    const sub = {
      id: "sub-1", companyId: "co-1", ownerUserId: "user-1", customerId: "cust-1",
      status: "active" as const, trialEndsAt: null, graceSince: null,
      currentPeriodEnd: "2026-08-18T12:00:00.000Z", cancelAtPeriodEnd: false,
      priceCentsOverride: 9900, providerSubscriptionId: "psub-1",
      openCheckoutSessionRef: null, openCheckoutUrl: null,
      createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
    };
    await store.insertSubscription(sub);
    await store.updateSubscription(sub);
    expect(executes[0].sql).toContain(`INSERT INTO ${DB_NAMESPACE}.subscriptions`);
    expect(executes[1].sql).toContain(`UPDATE ${DB_NAMESPACE}.subscriptions`);
    expect(executes[1].sql).toContain("WHERE id = $1");
    expect(executes[1].params?.[0]).toBe("sub-1");
  });

  it("normalizes Date values from the driver to ISO strings", async () => {
    const { db } = fakeDb({ rows: [{ ...DB_SUB_ROW, trial_ends_at: new Date("2026-07-25T12:00:00.000Z") }] });
    const sub = await new SqlBillingStore(db).getSubscriptionByCompany("co-1");
    expect(sub?.trialEndsAt).toBe("2026-07-25T12:00:00.000Z");
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/store-sql.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/store-sql.ts`:

```ts
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { DB_NAMESPACE } from "./constants.js";
import type { CustomerRow, LedgerInsert, LedgerRow, SubscriptionRow, SubscriptionStatus } from "./domain.js";
import type { BillingStore } from "./store.js";

const NS = DB_NAMESPACE;

const SUB_COLUMNS =
  "id, company_id, owner_user_id, customer_id, status, trial_ends_at, grace_since, current_period_end, "
  + "cancel_at_period_end, price_cents_override, provider_subscription_id, open_checkout_session_ref, "
  + "open_checkout_url, created_at, updated_at";

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return null;
}

function mapSub(row: Record<string, unknown>): SubscriptionRow {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    ownerUserId: String(row.owner_user_id),
    customerId: row.customer_id === null ? null : String(row.customer_id),
    status: String(row.status) as SubscriptionStatus,
    trialEndsAt: isoOrNull(row.trial_ends_at),
    graceSince: isoOrNull(row.grace_since),
    currentPeriodEnd: isoOrNull(row.current_period_end),
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    priceCentsOverride: row.price_cents_override === null ? null : Number(row.price_cents_override),
    providerSubscriptionId: row.provider_subscription_id === null ? null : String(row.provider_subscription_id),
    openCheckoutSessionRef: row.open_checkout_session_ref === null ? null : String(row.open_checkout_session_ref),
    openCheckoutUrl: row.open_checkout_url === null ? null : String(row.open_checkout_url),
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoOrNull(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function mapLedger(row: Record<string, unknown>): LedgerRow {
  const raw = row.raw_payload;
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    type: String(row.type),
    subscriptionId: row.subscription_id === null ? null : String(row.subscription_id),
    companyId: row.company_id === null ? null : String(row.company_id),
    rawPayload: typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : ((raw ?? {}) as Record<string, unknown>),
    appliedAt: isoOrNull(row.applied_at),
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
  };
}

export class SqlBillingStore implements BillingStore {
  constructor(private readonly db: PluginDatabaseClient) {}

  private async one(sql: string, params: unknown[]): Promise<SubscriptionRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(sql, params);
    return rows.length > 0 ? mapSub(rows[0]) : null;
  }

  getSubscriptionByCompany(companyId: string): Promise<SubscriptionRow | null> {
    return this.one(`SELECT ${SUB_COLUMNS} FROM ${NS}.subscriptions WHERE company_id = $1`, [companyId]);
  }

  getSubscriptionByProviderRef(subRef: string): Promise<SubscriptionRow | null> {
    return this.one(`SELECT ${SUB_COLUMNS} FROM ${NS}.subscriptions WHERE provider_subscription_id = $1`, [subRef]);
  }

  getSubscriptionBySessionRef(sessionRef: string): Promise<SubscriptionRow | null> {
    return this.one(`SELECT ${SUB_COLUMNS} FROM ${NS}.subscriptions WHERE open_checkout_session_ref = $1`, [sessionRef]);
  }

  async listSubscriptions(): Promise<SubscriptionRow[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${SUB_COLUMNS} FROM ${NS}.subscriptions ORDER BY created_at ASC`,
      [],
    );
    return rows.map(mapSub);
  }

  async insertSubscription(sub: SubscriptionRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${NS}.subscriptions (${SUB_COLUMNS}) `
      + "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
      [
        sub.id, sub.companyId, sub.ownerUserId, sub.customerId, sub.status, sub.trialEndsAt, sub.graceSince,
        sub.currentPeriodEnd, sub.cancelAtPeriodEnd, sub.priceCentsOverride, sub.providerSubscriptionId,
        sub.openCheckoutSessionRef, sub.openCheckoutUrl, sub.createdAt, sub.updatedAt,
      ],
    );
  }

  async updateSubscription(sub: SubscriptionRow): Promise<void> {
    await this.db.execute(
      `UPDATE ${NS}.subscriptions SET customer_id = $2, status = $3, trial_ends_at = $4, grace_since = $5, `
      + "current_period_end = $6, cancel_at_period_end = $7, price_cents_override = $8, "
      + "provider_subscription_id = $9, open_checkout_session_ref = $10, open_checkout_url = $11, "
      + "updated_at = $12 WHERE id = $1",
      [
        sub.id, sub.customerId, sub.status, sub.trialEndsAt, sub.graceSince, sub.currentPeriodEnd,
        sub.cancelAtPeriodEnd, sub.priceCentsOverride, sub.providerSubscriptionId,
        sub.openCheckoutSessionRef, sub.openCheckoutUrl, sub.updatedAt,
      ],
    );
  }

  async getCustomerByUser(provider: string, userId: string): Promise<CustomerRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, user_id, provider, provider_customer_id, has_default_payment_method FROM ${NS}.billing_customers WHERE provider = $1 AND user_id = $2`,
      [provider, userId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: String(row.id),
      userId: String(row.user_id),
      provider: String(row.provider),
      providerCustomerId: String(row.provider_customer_id),
      hasDefaultPaymentMethod: Boolean(row.has_default_payment_method),
    };
  }

  async upsertCustomer(customer: CustomerRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${NS}.billing_customers (id, user_id, provider, provider_customer_id, has_default_payment_method) `
      + "VALUES ($1, $2, $3, $4, $5) "
      + "ON CONFLICT (provider, user_id) DO UPDATE SET provider_customer_id = $4, has_default_payment_method = $5, updated_at = now()",
      [customer.id, customer.userId, customer.provider, customer.providerCustomerId, customer.hasDefaultPaymentMethod],
    );
  }

  async insertLedgerEvent(event: LedgerInsert): Promise<"inserted" | "duplicate"> {
    const result = await this.db.execute(
      `INSERT INTO ${NS}.billing_events (id, idempotency_key, type, subscription_id, company_id, raw_payload) `
      + "VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (idempotency_key) DO NOTHING",
      [event.id, event.idempotencyKey, event.type, event.subscriptionId, event.companyId, JSON.stringify(event.rawPayload)],
    );
    return result.rowCount > 0 ? "inserted" : "duplicate";
  }

  async markLedgerApplied(ledgerId: string, appliedAtIso: string): Promise<void> {
    await this.db.execute(`UPDATE ${NS}.billing_events SET applied_at = $2 WHERE id = $1`, [ledgerId, appliedAtIso]);
  }

  async listUnappliedLedgerEvents(limit: number): Promise<LedgerRow[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, idempotency_key, type, subscription_id, company_id, raw_payload, applied_at, created_at FROM ${NS}.billing_events WHERE applied_at IS NULL ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return rows.map(mapLedger);
  }

  async listLedgerEventsForCompany(companyId: string, limit: number): Promise<LedgerRow[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, idempotency_key, type, subscription_id, company_id, raw_payload, applied_at, created_at FROM ${NS}.billing_events WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [companyId, limit],
    );
    return rows.map(mapLedger);
  }

  async ownerHadTrial(ownerUserId: string): Promise<boolean> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id FROM ${NS}.billing_events WHERE type = 'trial.started' AND raw_payload->>'ownerUserId' = $1 LIMIT 1`,
      [ownerUserId],
    );
    return rows.length > 0;
  }
}
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/store-sql.spec.ts` — expect all passing.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/store-sql.ts packages/plugins/plugin-billing/tests/store-sql.spec.ts
git commit -m "feat(plugin-billing): namespace-scoped SQL store adapter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: HMAC signing + per-install webhook secret

**Files:**
- Create: `packages/plugins/plugin-billing/src/hmac.ts`
- Test: `packages/plugins/plugin-billing/tests/hmac.spec.ts`

**Interfaces:**
- Consumes: `node:crypto`; `ctx.state` (`PluginStateClient` — `get/set` with `{ scopeKind: "instance", stateKey }`; requires `plugin.state.read`/`plugin.state.write`).
- Produces:

```ts
export class WebhookVerificationError extends Error {}
export function signStubPayload(secret: string, rawBody: string): string; // hex HMAC-SHA256
export function verifyStubSignature(secret: string, rawBody: string, signature: string | undefined): boolean; // timing-safe
export function headerValue(headers: Record<string, string | string[]>, name: string): string | undefined; // case-insensitive, first value
export async function ensureStubWebhookSecret(state: PluginStateClient): Promise<string>; // generate-once, stored in instance-scoped plugin state
```

Decision (from ground truth): the per-install HMAC secret lives in **instance-scoped plugin state** (`ctx.state`, scope `{ scopeKind: "instance", stateKey: "stub-webhook-secret" }`) — not in config (config is operator-editable JSON and must never hold secret material) and not in `ctx.secrets` (secret refs are company-scoped and operator-provisioned; the stub needs a zero-setup generated secret).

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/hmac.spec.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PluginStateClient } from "@paperclipai/plugin-sdk";
import { ensureStubWebhookSecret, headerValue, signStubPayload, verifyStubSignature } from "../src/hmac.js";

describe("stub HMAC", () => {
  it("signs with HMAC-SHA256 hex over the exact raw body", () => {
    const expected = createHmac("sha256", "s3cret").update("{\"a\":1}").digest("hex");
    expect(signStubPayload("s3cret", "{\"a\":1}")).toBe(expected);
  });

  it("verifies a valid signature and rejects tampered body, wrong secret, missing or malformed signature", () => {
    const body = JSON.stringify({ type: "payment.succeeded", subRef: "psub-1" });
    const sig = signStubPayload("s3cret", body);
    expect(verifyStubSignature("s3cret", body, sig)).toBe(true);
    expect(verifyStubSignature("s3cret", body + " ", sig)).toBe(false);
    expect(verifyStubSignature("other", body, sig)).toBe(false);
    expect(verifyStubSignature("s3cret", body, undefined)).toBe(false);
    expect(verifyStubSignature("s3cret", body, "zz-not-hex")).toBe(false);
    expect(verifyStubSignature("s3cret", body, sig.slice(0, 10))).toBe(false);
  });

  it("headerValue is case-insensitive and unwraps arrays", () => {
    const headers = { "X-Billing-Stub-Signature": ["abc", "def"], other: "x" };
    expect(headerValue(headers, "x-billing-stub-signature")).toBe("abc");
    expect(headerValue(headers, "missing")).toBeUndefined();
  });
});

describe("ensureStubWebhookSecret", () => {
  function fakeState(): { state: PluginStateClient; values: Map<string, unknown> } {
    const values = new Map<string, unknown>();
    const key = (input: { scopeKind: string; stateKey: string }) => `${input.scopeKind}:${input.stateKey}`;
    const state = {
      async get(input: { scopeKind: "instance"; stateKey: string }) { return values.get(key(input)) ?? null; },
      async set(input: { scopeKind: "instance"; stateKey: string }, value: unknown) { values.set(key(input), value); },
      async delete() {},
    } as unknown as PluginStateClient;
    return { state, values };
  }

  it("generates a 64-hex-char secret once and returns the same one afterwards", async () => {
    const { state } = fakeState();
    const first = await ensureStubWebhookSecret(state);
    const second = await ensureStubWebhookSecret(state);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/hmac.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/hmac.ts`:

```ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PluginStateClient } from "@paperclipai/plugin-sdk";

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export function signStubPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifyStubSignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = Buffer.from(signStubPayload(secret, rawBody), "hex");
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

/** Node lowercases inbound header names, but be defensive: case-insensitive lookup, first value wins. */
export function headerValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

const SECRET_STATE_KEY = "stub-webhook-secret";

/**
 * Per-install stub webhook secret: generated once, persisted in
 * instance-scoped plugin state. Never logged, never placed in config JSON.
 */
export async function ensureStubWebhookSecret(state: PluginStateClient): Promise<string> {
  const existing = await state.get({ scopeKind: "instance", stateKey: SECRET_STATE_KEY });
  if (typeof existing === "string" && /^[0-9a-f]{64}$/.test(existing)) return existing;
  const secret = randomBytes(32).toString("hex");
  await state.set({ scopeKind: "instance", stateKey: SECRET_STATE_KEY }, secret);
  return secret;
}
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/hmac.spec.ts` — expect all passing.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/hmac.ts packages/plugins/plugin-billing/tests/hmac.spec.ts
git commit -m "feat(plugin-billing): HMAC signing utilities and per-install webhook secret

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 10: BillingProvider interface + stub provider

**Files:**
- Create: `packages/plugins/plugin-billing/src/provider/types.ts`
- Create: `packages/plugins/plugin-billing/src/provider/stub.ts`
- Test: `packages/plugins/plugin-billing/tests/stub-provider.spec.ts`

**Interfaces:**
- Consumes: `hmac.ts` (Task 9), constants (Task 1), `PluginDatabaseClient` (for `SqlStubStateStore`).
- Produces: `BillingProvider` (spec §5, typed transliteration — same method and field names), `ParsedProviderEvent`, `StubProvider` + `StubStateStore` (`MemoryStubStateStore`, `SqlStubStateStore`) + `StubTransport` (`HttpStubTransport`).
- Stub billing period is 30 days. Every stub event body includes `companyId` so webhook resolution has a final fallback (Global Constraints deviation 5). Delivery failures re-queue the raw signed body as a due event; the sweep retries.

Steps:

- [ ] Create `packages/plugins/plugin-billing/src/provider/types.ts` first (pure types — nothing to test-drive):

```ts
/**
 * Provider port — spec §5 verbatim (typed transliteration; the spec block uses
 * TS shorthand without types). Stripe-shaped so the future adapter is mechanical.
 *
 * Rules (every provider):
 * - Webhook signatures are always verified; unverifiable ⇒ throw, never a state change.
 * - The webhook handler 200-acks only after ledger insert; unique idempotency_key
 *   makes duplicates no-ops.
 * - Provider outage never changes standing — only explicit events and the sweep do.
 * - Redirect/query params are never trusted for state; resolveCheckout is a
 *   server-side provider query, and the webhook remains the source of truth.
 */
export type ParsedProviderEvent =
  | { type: "checkout.completed"; sessionRef: string; subRef: string; periodEnd: string }
  | { type: "payment.succeeded"; subRef: string; periodEnd: string }
  | { type: "payment.failed"; subRef: string }
  | { type: "subscription.canceled"; subRef: string };

export interface BillingProvider {
  ensureCustomer(user: { id: string; email: string; name: string }): Promise<{ customerId: string }>;

  createCheckout(req: {
    customerId: string;
    companyId: string;
    priceCents: number;
    currency: string;
    /** subscribe-during-trial keeps remaining trial */
    trialEndsAt?: Date;
    /** successUrl carries {SESSION_REF} */
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionRef: string }>;

  /** instant success-page confirmation */
  resolveCheckout?(sessionRef: string): Promise<"complete" | "open" | "expired">;

  /** SCA fallback */
  subscribeWithSavedMethod(req: {
    customerId: string;
    companyId: string;
    priceCents: number;
    currency: string;
    trialEndsAt?: Date;
  }): Promise<{ status: "active" } | { status: "requires_action"; url: string }>;

  createPortal?(customerId: string): Promise<{ url: string }>;

  cancelAtPeriodEnd(subRef: string): Promise<void>;
  resume(subRef: string): Promise<void>;
  /** company deletion */
  cancelNow(subRef: string): Promise<void>;

  verifyAndParseWebhook(
    headers: Record<string, string | string[]>,
    rawBody: string,
  ): ParsedProviderEvent;
}
```

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/stub-provider.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CHECKOUT_PAGE_ROUTE, STUB_SIGNATURE_HEADER } from "../src/constants.js";
import { WebhookVerificationError, signStubPayload } from "../src/hmac.js";
import { MemoryStubStateStore, StubProvider } from "../src/provider/stub.js";

const SECRET = "a".repeat(64);
const NOW = new Date("2026-07-18T12:00:00.000Z");
const DAY = 86_400_000;

interface Delivery { headers: Record<string, string>; body: Record<string, unknown>; rawBody: string; }

function makeStub(options: { failDeliveries?: number } = {}) {
  const deliveries: Delivery[] = [];
  let failures = options.failDeliveries ?? 0;
  let now = NOW;
  const store = new MemoryStubStateStore();
  const provider = new StubProvider({
    store,
    secret: SECRET,
    transport: {
      async deliver(headers, rawBody) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("connection refused");
        }
        deliveries.push({ headers, rawBody, body: JSON.parse(rawBody) as Record<string, unknown> });
      },
    },
    now: () => now,
  });
  return { provider, store, deliveries, setNow: (d: Date) => { now = d; } };
}

async function subscribedCompany(stub: ReturnType<typeof makeStub>) {
  const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
  const { sessionRef } = await stub.provider.createCheckout({
    customerId, companyId: "co-1", priceCents: 4900, currency: "EUR",
    successUrl: "company/settings/billing?checkout=success&session={SESSION_REF}",
    cancelUrl: "company/settings/billing?checkout=cancel",
  });
  await stub.provider.completeCheckout(sessionRef, { savePaymentMethod: false });
  const event = stub.deliveries.at(-1)!.body as { subRef: string; periodEnd: string };
  return { customerId, sessionRef, subRef: event.subRef, periodEnd: event.periodEnd };
}

describe("StubProvider — customers and checkout", () => {
  it("ensureCustomer is idempotent per user", async () => {
    const stub = makeStub();
    const first = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    const second = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    expect(second.customerId).toBe(first.customerId);
  });

  it("createCheckout opens a session, substitutes {SESSION_REF}, and returns the simulator url", async () => {
    const stub = makeStub();
    const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    const { url, sessionRef } = await stub.provider.createCheckout({
      customerId, companyId: "co-1", priceCents: 4900, currency: "EUR",
      trialEndsAt: new Date("2026-07-25T12:00:00.000Z"),
      successUrl: "company/settings/billing?checkout=success&session={SESSION_REF}",
      cancelUrl: "company/settings/billing?checkout=cancel",
    });
    expect(url).toBe(`${CHECKOUT_PAGE_ROUTE}?session=${sessionRef}`);
    const session = await stub.provider.getSession(sessionRef);
    expect(session).toMatchObject({
      status: "open", kind: "checkout", companyId: "co-1", priceCents: 4900,
      trialEndsAtIso: "2026-07-25T12:00:00.000Z",
      successUrl: `company/settings/billing?checkout=success&session=${sessionRef}`,
    });
    expect(await stub.provider.resolveCheckout(sessionRef)).toBe("open");
    expect(await stub.provider.resolveCheckout("sess_unknown")).toBe("expired");
  });

  it("completeCheckout emits a correctly signed checkout.completed honoring trialEndsAt, and saves the payment method", async () => {
    const stub = makeStub();
    const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    const { sessionRef } = await stub.provider.createCheckout({
      customerId, companyId: "co-1", priceCents: 4900, currency: "EUR",
      trialEndsAt: new Date("2026-07-25T12:00:00.000Z"),
      successUrl: "s?session={SESSION_REF}", cancelUrl: "c",
    });
    await stub.provider.completeCheckout(sessionRef, { savePaymentMethod: true });

    expect(stub.deliveries).toHaveLength(1);
    const { headers, rawBody, body } = stub.deliveries[0];
    expect(headers[STUB_SIGNATURE_HEADER]).toBe(signStubPayload(SECRET, rawBody));
    expect(body).toMatchObject({
      type: "checkout.completed",
      sessionRef,
      companyId: "co-1",
      periodEnd: "2026-07-25T12:00:00.000Z", // billing starts when the trial ends
    });
    expect(typeof body.subRef).toBe("string");
    expect(typeof body.eventId).toBe("string");
    expect(await stub.provider.resolveCheckout(sessionRef)).toBe("complete");
    expect(await stub.provider.customerHasSavedMethod(customerId)).toBe(true);
  });

  it("failCheckout records the decline and keeps the session open; cancelCheckout expires it silently", async () => {
    const stub = makeStub();
    const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    const a = await stub.provider.createCheckout({ customerId, companyId: "co-1", priceCents: 4900, currency: "EUR", successUrl: "s?session={SESSION_REF}", cancelUrl: "c" });
    await stub.provider.failCheckout(a.sessionRef);
    expect((await stub.provider.getSession(a.sessionRef))?.lastError).toBe("card_declined");
    expect(await stub.provider.resolveCheckout(a.sessionRef)).toBe("open");
    await stub.provider.cancelCheckout(a.sessionRef);
    expect(await stub.provider.resolveCheckout(a.sessionRef)).toBe("expired");
    expect(stub.deliveries).toHaveLength(0); // neither fail nor cancel changes state via webhook
  });
});

describe("StubProvider — saved method and SCA", () => {
  it("subscribeWithSavedMethod activates immediately and emits payment.succeeded", async () => {
    const stub = makeStub();
    const { customerId } = await subscribedCompany(stub);
    // saved method was not stored above; store it now
    await stub.provider.setSavedMethod(customerId, true);
    const result = await stub.provider.subscribeWithSavedMethod({ customerId, companyId: "co-2", priceCents: 4900, currency: "EUR" });
    expect(result).toEqual({ status: "active" });
    const event = stub.deliveries.at(-1)!.body;
    expect(event).toMatchObject({ type: "payment.succeeded", companyId: "co-2" });
    expect(typeof event.subRef).toBe("string");
  });

  it("rejects one-click without a saved method", async () => {
    const stub = makeStub();
    const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    await expect(
      stub.provider.subscribeWithSavedMethod({ customerId, companyId: "co-2", priceCents: 4900, currency: "EUR" }),
    ).rejects.toThrow("no saved payment method");
  });

  it("requires_action branch returns an SCA session whose completion emits checkout.completed", async () => {
    const stub = makeStub();
    const { customerId } = await subscribedCompany(stub);
    await stub.provider.setSavedMethod(customerId, true);
    await stub.provider.setScaRequired(customerId, true);
    const result = await stub.provider.subscribeWithSavedMethod({ customerId, companyId: "co-3", priceCents: 4900, currency: "EUR" });
    if (result.status !== "requires_action") throw new Error("expected requires_action");
    const sessionRef = new URL(result.url, "http://x.invalid").searchParams.get("session")!;
    expect((await stub.provider.getSession(sessionRef))?.kind).toBe("sca");
    await stub.provider.completeCheckout(sessionRef, { savePaymentMethod: false });
    expect(stub.deliveries.at(-1)!.body).toMatchObject({ type: "checkout.completed", sessionRef, companyId: "co-3" });
  });
});

describe("StubProvider — renewals, dunning, cancellation", () => {
  it("deliverDue renews an active subscription: payment.succeeded, +30 days, next renewal scheduled", async () => {
    const stub = makeStub();
    const { subRef, periodEnd } = await subscribedCompany(stub);
    stub.setNow(new Date(Date.parse(periodEnd) + 1));
    const delivered = await stub.provider.deliverDue(new Date(Date.parse(periodEnd) + 1));
    expect(delivered).toBe(1);
    const renewal = stub.deliveries.at(-1)!.body as { type: string; subRef: string; periodEnd: string };
    expect(renewal.type).toBe("payment.succeeded");
    expect(renewal.subRef).toBe(subRef);
    expect(Date.parse(renewal.periodEnd)).toBe(Date.parse(periodEnd) + 30 * DAY);
    // and nothing more is due until the new period end
    expect(await stub.provider.deliverDue(new Date(Date.parse(periodEnd) + 2))).toBe(0);
  });

  it("failNextRenewal produces payment.failed with a delayed retry that succeeds after the flag clears", async () => {
    const stub = makeStub();
    const { subRef, periodEnd } = await subscribedCompany(stub);
    await stub.provider.setFailNextRenewal(subRef, true);
    const dueAt = new Date(Date.parse(periodEnd) + 1);
    await stub.provider.deliverDue(dueAt);
    expect(stub.deliveries.at(-1)!.body).toMatchObject({ type: "payment.failed", subRef });
    // delayed dunning retry: due one day later, not immediately
    expect(await stub.provider.deliverDue(dueAt)).toBe(0);
    await stub.provider.setFailNextRenewal(subRef, false);
    const retryAt = new Date(dueAt.getTime() + DAY);
    expect(await stub.provider.deliverDue(retryAt)).toBe(1);
    expect(stub.deliveries.at(-1)!.body).toMatchObject({ type: "payment.succeeded", subRef });
  });

  it("cancelAtPeriodEnd converts the next renewal into subscription.canceled; resume restores renewals", async () => {
    const stub = makeStub();
    const { subRef, periodEnd } = await subscribedCompany(stub);
    await stub.provider.cancelAtPeriodEnd(subRef);
    await stub.provider.resume(subRef);
    await stub.provider.cancelAtPeriodEnd(subRef);
    await stub.provider.deliverDue(new Date(Date.parse(periodEnd) + 1));
    expect(stub.deliveries.at(-1)!.body).toMatchObject({ type: "subscription.canceled", subRef });
  });

  it("cancelNow emits subscription.canceled immediately and drops pending renewals", async () => {
    const stub = makeStub();
    const { subRef, periodEnd } = await subscribedCompany(stub);
    await stub.provider.cancelNow(subRef);
    expect(stub.deliveries.at(-1)!.body).toMatchObject({ type: "subscription.canceled", subRef });
    expect(await stub.provider.deliverDue(new Date(Date.parse(periodEnd) + 1))).toBe(0);
  });

  it("re-queues the raw signed body when the transport fails and redelivers it on deliverDue", async () => {
    const stub = makeStub({ failDeliveries: 1 });
    const { customerId } = await stub.provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    const { sessionRef } = await stub.provider.createCheckout({ customerId, companyId: "co-1", priceCents: 4900, currency: "EUR", successUrl: "s?session={SESSION_REF}", cancelUrl: "c" });
    await stub.provider.completeCheckout(sessionRef, { savePaymentMethod: false }); // delivery fails silently
    expect(stub.deliveries).toHaveLength(0);
    await stub.provider.deliverDue(NOW);
    expect(stub.deliveries).toHaveLength(1);
    const { headers, rawBody, body } = stub.deliveries[0];
    expect(body).toMatchObject({ type: "checkout.completed", sessionRef });
    expect(headers[STUB_SIGNATURE_HEADER]).toBe(signStubPayload(SECRET, rawBody));
  });
});

describe("StubProvider — verifyAndParseWebhook", () => {
  function signed(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return { rawBody, headers: { [STUB_SIGNATURE_HEADER]: signStubPayload(SECRET, rawBody) } };
  }

  it("parses each of the four event types", () => {
    const stub = makeStub();
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { eventId: "e1", type: "checkout.completed", sessionRef: "s1", subRef: "p1", periodEnd: "2026-08-18T12:00:00.000Z", companyId: "co-1" },
        { type: "checkout.completed", sessionRef: "s1", subRef: "p1", periodEnd: "2026-08-18T12:00:00.000Z" },
      ],
      [
        { eventId: "e2", type: "payment.succeeded", subRef: "p1", periodEnd: "2026-09-17T12:00:00.000Z", companyId: "co-1" },
        { type: "payment.succeeded", subRef: "p1", periodEnd: "2026-09-17T12:00:00.000Z" },
      ],
      [{ eventId: "e3", type: "payment.failed", subRef: "p1", companyId: "co-1" }, { type: "payment.failed", subRef: "p1" }],
      [{ eventId: "e4", type: "subscription.canceled", subRef: "p1", companyId: "co-1" }, { type: "subscription.canceled", subRef: "p1" }],
    ];
    for (const [body, expected] of cases) {
      const { rawBody, headers } = signed(body);
      expect(stub.provider.verifyAndParseWebhook(headers, rawBody)).toEqual(expected);
    }
  });

  it("throws WebhookVerificationError on missing/invalid signature or tampered body — never returns", () => {
    const stub = makeStub();
    const { rawBody, headers } = signed({ eventId: "e1", type: "payment.failed", subRef: "p1" });
    expect(() => stub.provider.verifyAndParseWebhook({}, rawBody)).toThrow(WebhookVerificationError);
    expect(() => stub.provider.verifyAndParseWebhook({ [STUB_SIGNATURE_HEADER]: "00" }, rawBody)).toThrow(WebhookVerificationError);
    expect(() => stub.provider.verifyAndParseWebhook(headers, rawBody.replace("p1", "p2"))).toThrow(WebhookVerificationError);
  });

  it("throws on a validly-signed but unknown event type", () => {
    const stub = makeStub();
    const { rawBody, headers } = signed({ eventId: "e1", type: "invoice.finalized" });
    expect(() => stub.provider.verifyAndParseWebhook(headers, rawBody)).toThrow("unknown stub event type");
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/stub-provider.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/provider/stub.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { CHECKOUT_PAGE_ROUTE, DB_NAMESPACE, STUB_SIGNATURE_HEADER, WEBHOOK_PATH } from "../constants.js";
import { WebhookVerificationError, headerValue, signStubPayload, verifyStubSignature } from "../hmac.js";
import type { BillingProvider, ParsedProviderEvent } from "./types.js";

const DAY_MS = 86_400_000;
const PERIOD_MS = 30 * DAY_MS;
const DUNNING_RETRY_MS = 1 * DAY_MS;

export interface StubCustomer {
  customerId: string;
  userId: string;
  email: string;
  name: string;
  hasSavedMethod: boolean;
  scaRequired: boolean;
}

export interface StubSession {
  sessionRef: string;
  kind: "checkout" | "sca";
  customerId: string;
  companyId: string;
  priceCents: number;
  currency: string;
  trialEndsAtIso: string | null;
  successUrl: string;
  cancelUrl: string;
  status: "open" | "complete" | "expired";
  lastError: string | null;
  createdAtIso: string;
}

export interface StubSubscription {
  subRef: string;
  customerId: string;
  companyId: string;
  priceCents: number;
  currency: string;
  status: "active" | "past_due" | "canceled";
  periodEndIso: string;
  cancelAtPeriodEnd: boolean;
  failNextRenewal: boolean;
}

interface StubDueEvent {
  id: string;
  dueAtIso: string;
  /** {kind:"renewal", subRef} or {kind:"raw", rawBody, signature} (redelivery). */
  payload:
    | { kind: "renewal"; subRef: string }
    | { kind: "raw"; rawBody: string; signature: string };
}

export interface StubState {
  customers: StubCustomer[];
  sessions: StubSession[];
  subscriptions: StubSubscription[];
  dueEvents: StubDueEvent[];
}

export function emptyStubState(): StubState {
  return { customers: [], sessions: [], subscriptions: [], dueEvents: [] };
}

export interface StubStateStore {
  load(): Promise<StubState>;
  save(state: StubState): Promise<void>;
}

export class MemoryStubStateStore implements StubStateStore {
  private state: StubState = emptyStubState();

  async load(): Promise<StubState> {
    return JSON.parse(JSON.stringify(this.state)) as StubState;
  }

  async save(state: StubState): Promise<void> {
    this.state = JSON.parse(JSON.stringify(state)) as StubState;
  }
}

/** Persists the whole stub-provider state as the singleton stub_state row. */
export class SqlStubStateStore implements StubStateStore {
  constructor(private readonly db: PluginDatabaseClient) {}

  async load(): Promise<StubState> {
    const rows = await this.db.query<{ state: unknown }>(
      `SELECT state FROM ${DB_NAMESPACE}.stub_state WHERE id = 1`,
      [],
    );
    const raw = rows[0]?.state;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const state = (parsed ?? {}) as Partial<StubState>;
    return {
      customers: state.customers ?? [],
      sessions: state.sessions ?? [],
      subscriptions: state.subscriptions ?? [],
      dueEvents: state.dueEvents ?? [],
    };
  }

  async save(state: StubState): Promise<void> {
    await this.db.execute(
      `UPDATE ${DB_NAMESPACE}.stub_state SET state = $1::jsonb, updated_at = now() WHERE id = 1`,
      [JSON.stringify(state)],
    );
  }
}

export interface StubTransport {
  deliver(headers: Record<string, string>, rawBody: string): Promise<void>;
}

/**
 * Production transport: POSTs signed events to this plugin's own manifest
 * webhook endpoint so the entire production path (signature verify → ledger →
 * transition → standing) is exercised with no external account. The route is
 * unauthenticated-but-signed by design (PLUGIN_SPEC §18).
 */
export class HttpStubTransport implements StubTransport {
  constructor(private readonly baseUrl: () => Promise<string>) {}

  async deliver(headers: Record<string, string>, rawBody: string): Promise<void> {
    const base = (await this.baseUrl()).replace(/\/$/, "");
    const response = await fetch(`${base}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: rawBody,
    });
    if (!response.ok) {
      throw new Error(`stub webhook delivery failed with status ${response.status}`);
    }
  }
}

export class StubProvider implements BillingProvider {
  constructor(
    private readonly deps: {
      store: StubStateStore;
      secret: string;
      transport: StubTransport;
      now: () => Date;
    },
  ) {}

  // -------------------------------------------------------------- internals

  private async mutate<T>(fn: (state: StubState) => Promise<T> | T): Promise<T> {
    const state = await this.deps.store.load();
    const result = await fn(state);
    await this.deps.store.save(state);
    return result;
  }

  /** Sign and deliver; on transport failure queue the exact signed body for redelivery. */
  private async emit(state: StubState, body: Record<string, unknown>): Promise<void> {
    const rawBody = JSON.stringify({ eventId: randomUUID(), sentAt: this.deps.now().toISOString(), ...body });
    const signature = signStubPayload(this.deps.secret, rawBody);
    try {
      await this.deps.transport.deliver({ [STUB_SIGNATURE_HEADER]: signature }, rawBody);
    } catch {
      state.dueEvents.push({
        id: randomUUID(),
        dueAtIso: this.deps.now().toISOString(),
        payload: { kind: "raw", rawBody, signature },
      });
    }
  }

  private scheduleRenewal(state: StubState, subRef: string, dueAtIso: string): void {
    state.dueEvents.push({ id: randomUUID(), dueAtIso, payload: { kind: "renewal", subRef } });
  }

  private activateSession(state: StubState, session: StubSession): StubSubscription {
    const periodEndIso = session.trialEndsAtIso ?? new Date(this.deps.now().getTime() + PERIOD_MS).toISOString();
    const sub: StubSubscription = {
      subRef: `stub_sub_${randomUUID()}`,
      customerId: session.customerId,
      companyId: session.companyId,
      priceCents: session.priceCents,
      currency: session.currency,
      status: "active",
      periodEndIso,
      cancelAtPeriodEnd: false,
      failNextRenewal: false,
    };
    state.subscriptions.push(sub);
    this.scheduleRenewal(state, sub.subRef, periodEndIso);
    session.status = "complete";
    return sub;
  }

  // -------------------------------------------------- BillingProvider port

  async ensureCustomer(user: { id: string; email: string; name: string }): Promise<{ customerId: string }> {
    return this.mutate((state) => {
      const existing = state.customers.find((c) => c.userId === user.id);
      if (existing) return { customerId: existing.customerId };
      const customer: StubCustomer = {
        customerId: `stub_cus_${randomUUID()}`,
        userId: user.id,
        email: user.email,
        name: user.name,
        hasSavedMethod: false,
        scaRequired: false,
      };
      state.customers.push(customer);
      return { customerId: customer.customerId };
    });
  }

  async createCheckout(req: {
    customerId: string;
    companyId: string;
    priceCents: number;
    currency: string;
    trialEndsAt?: Date;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionRef: string }> {
    return this.mutate((state) => {
      const sessionRef = `stub_sess_${randomUUID()}`;
      state.sessions.push({
        sessionRef,
        kind: "checkout",
        customerId: req.customerId,
        companyId: req.companyId,
        priceCents: req.priceCents,
        currency: req.currency,
        trialEndsAtIso: req.trialEndsAt ? req.trialEndsAt.toISOString() : null,
        successUrl: req.successUrl.replaceAll("{SESSION_REF}", sessionRef),
        cancelUrl: req.cancelUrl,
        status: "open",
        lastError: null,
        createdAtIso: this.deps.now().toISOString(),
      });
      return { url: `${CHECKOUT_PAGE_ROUTE}?session=${sessionRef}`, sessionRef };
    });
  }

  async resolveCheckout(sessionRef: string): Promise<"complete" | "open" | "expired"> {
    const state = await this.deps.store.load();
    const session = state.sessions.find((s) => s.sessionRef === sessionRef);
    if (!session) return "expired";
    return session.status;
  }

  async subscribeWithSavedMethod(req: {
    customerId: string;
    companyId: string;
    priceCents: number;
    currency: string;
    trialEndsAt?: Date;
  }): Promise<{ status: "active" } | { status: "requires_action"; url: string }> {
    return this.mutate(async (state) => {
      const customer = state.customers.find((c) => c.customerId === req.customerId);
      if (!customer || !customer.hasSavedMethod) {
        throw new Error("no saved payment method on file for this customer");
      }
      if (customer.scaRequired) {
        const sessionRef = `stub_sess_${randomUUID()}`;
        state.sessions.push({
          sessionRef,
          kind: "sca",
          customerId: req.customerId,
          companyId: req.companyId,
          priceCents: req.priceCents,
          currency: req.currency,
          trialEndsAtIso: req.trialEndsAt ? req.trialEndsAt.toISOString() : null,
          successUrl: "",
          cancelUrl: "",
          status: "open",
          lastError: null,
          createdAtIso: this.deps.now().toISOString(),
        });
        return { status: "requires_action" as const, url: `${CHECKOUT_PAGE_ROUTE}?session=${sessionRef}` };
      }
      const periodEndIso = req.trialEndsAt
        ? req.trialEndsAt.toISOString()
        : new Date(this.deps.now().getTime() + PERIOD_MS).toISOString();
      const sub: StubSubscription = {
        subRef: `stub_sub_${randomUUID()}`,
        customerId: req.customerId,
        companyId: req.companyId,
        priceCents: req.priceCents,
        currency: req.currency,
        status: "active",
        periodEndIso,
        cancelAtPeriodEnd: false,
        failNextRenewal: false,
      };
      state.subscriptions.push(sub);
      this.scheduleRenewal(state, sub.subRef, periodEndIso);
      await this.emit(state, {
        type: "payment.succeeded",
        subRef: sub.subRef,
        periodEnd: periodEndIso,
        companyId: req.companyId,
      });
      return { status: "active" as const };
    });
  }

  async cancelAtPeriodEnd(subRef: string): Promise<void> {
    await this.mutate((state) => {
      const sub = state.subscriptions.find((s) => s.subRef === subRef);
      if (sub) sub.cancelAtPeriodEnd = true;
    });
  }

  async resume(subRef: string): Promise<void> {
    await this.mutate((state) => {
      const sub = state.subscriptions.find((s) => s.subRef === subRef);
      if (sub) sub.cancelAtPeriodEnd = false;
    });
  }

  async cancelNow(subRef: string): Promise<void> {
    await this.mutate(async (state) => {
      const sub = state.subscriptions.find((s) => s.subRef === subRef);
      if (!sub || sub.status === "canceled") return;
      sub.status = "canceled";
      state.dueEvents = state.dueEvents.filter(
        (event) => !(event.payload.kind === "renewal" && event.payload.subRef === subRef),
      );
      await this.emit(state, { type: "subscription.canceled", subRef, companyId: sub.companyId });
    });
  }

  verifyAndParseWebhook(headers: Record<string, string | string[]>, rawBody: string): ParsedProviderEvent {
    const signature = headerValue(headers, STUB_SIGNATURE_HEADER);
    if (!verifyStubSignature(this.deps.secret, rawBody, signature)) {
      throw new WebhookVerificationError("invalid or missing stub webhook signature");
    }
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    switch (body.type) {
      case "checkout.completed":
        return {
          type: "checkout.completed",
          sessionRef: String(body.sessionRef),
          subRef: String(body.subRef),
          periodEnd: String(body.periodEnd),
        };
      case "payment.succeeded":
        return { type: "payment.succeeded", subRef: String(body.subRef), periodEnd: String(body.periodEnd) };
      case "payment.failed":
        return { type: "payment.failed", subRef: String(body.subRef) };
      case "subscription.canceled":
        return { type: "subscription.canceled", subRef: String(body.subRef) };
      default:
        throw new Error(`unknown stub event type: ${String(body.type)}`);
    }
  }

  // ------------------------------------------------ simulator/test surface

  async getSession(sessionRef: string): Promise<StubSession | null> {
    const state = await this.deps.store.load();
    return state.sessions.find((s) => s.sessionRef === sessionRef) ?? null;
  }

  /** Simulator "Pay" button; also completes SCA sessions. */
  async completeCheckout(sessionRef: string, options: { savePaymentMethod: boolean }): Promise<void> {
    await this.mutate(async (state) => {
      const session = state.sessions.find((s) => s.sessionRef === sessionRef);
      if (!session || session.status !== "open") {
        throw new Error(`stub session ${sessionRef} is not open`);
      }
      if (options.savePaymentMethod) {
        const customer = state.customers.find((c) => c.customerId === session.customerId);
        if (customer) customer.hasSavedMethod = true;
      }
      const sub = this.activateSession(state, session);
      await this.emit(state, {
        type: "checkout.completed",
        sessionRef,
        subRef: sub.subRef,
        periodEnd: sub.periodEndIso,
        companyId: session.companyId,
      });
    });
  }

  /** Simulator "Payment fails" button: decline, session stays open, no event. */
  async failCheckout(sessionRef: string): Promise<void> {
    await this.mutate((state) => {
      const session = state.sessions.find((s) => s.sessionRef === sessionRef);
      if (session && session.status === "open") session.lastError = "card_declined";
    });
  }

  /** Simulator "Cancel" button: expire the session, state unchanged (spec §6.3). */
  async cancelCheckout(sessionRef: string): Promise<void> {
    await this.mutate((state) => {
      const session = state.sessions.find((s) => s.sessionRef === sessionRef);
      if (session && session.status === "open") session.status = "expired";
    });
  }

  async setSavedMethod(customerId: string, hasSavedMethod: boolean): Promise<void> {
    await this.mutate((state) => {
      const customer = state.customers.find((c) => c.customerId === customerId);
      if (customer) customer.hasSavedMethod = hasSavedMethod;
    });
  }

  async setScaRequired(customerId: string, scaRequired: boolean): Promise<void> {
    await this.mutate((state) => {
      const customer = state.customers.find((c) => c.customerId === customerId);
      if (customer) customer.scaRequired = scaRequired;
    });
  }

  async setFailNextRenewal(subRef: string, fail: boolean): Promise<void> {
    await this.mutate((state) => {
      const sub = state.subscriptions.find((s) => s.subRef === subRef);
      if (sub) sub.failNextRenewal = fail;
    });
  }

  async customerHasSavedMethod(customerId: string): Promise<boolean> {
    const state = await this.deps.store.load();
    return state.customers.find((c) => c.customerId === customerId)?.hasSavedMethod ?? false;
  }

  /**
   * Deliver every due event (renewals, dunning retries, failed-transport
   * redeliveries). Called by the billing-sweep job; deterministic in tests.
   */
  async deliverDue(now: Date): Promise<number> {
    return this.mutate(async (state) => {
      const due = state.dueEvents.filter((event) => Date.parse(event.dueAtIso) <= now.getTime());
      state.dueEvents = state.dueEvents.filter((event) => Date.parse(event.dueAtIso) > now.getTime());
      let delivered = 0;

      for (const event of due) {
        if (event.payload.kind === "raw") {
          try {
            await this.deps.transport.deliver(
              { [STUB_SIGNATURE_HEADER]: event.payload.signature },
              event.payload.rawBody,
            );
            delivered += 1;
          } catch {
            state.dueEvents.push({ ...event, dueAtIso: new Date(now.getTime() + DUNNING_RETRY_MS).toISOString() });
          }
          continue;
        }

        const sub = state.subscriptions.find((s) => s.subRef === (event.payload as { subRef: string }).subRef);
        if (!sub || sub.status === "canceled") continue;

        if (sub.cancelAtPeriodEnd) {
          sub.status = "canceled";
          await this.emit(state, { type: "subscription.canceled", subRef: sub.subRef, companyId: sub.companyId });
          delivered += 1;
          continue;
        }

        if (sub.failNextRenewal) {
          sub.status = "past_due";
          await this.emit(state, { type: "payment.failed", subRef: sub.subRef, companyId: sub.companyId });
          this.scheduleRenewal(state, sub.subRef, new Date(now.getTime() + DUNNING_RETRY_MS).toISOString());
          delivered += 1;
          continue;
        }

        sub.status = "active";
        sub.periodEndIso = new Date(Date.parse(sub.periodEndIso) + PERIOD_MS).toISOString();
        this.scheduleRenewal(state, sub.subRef, sub.periodEndIso);
        await this.emit(state, {
          type: "payment.succeeded",
          subRef: sub.subRef,
          periodEnd: sub.periodEndIso,
          companyId: sub.companyId,
        });
        delivered += 1;
      }

      return delivered;
    });
  }
}
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/stub-provider.spec.ts` — expect all passing. Note: the dunning-retry renewal keeps the ORIGINAL `periodEndIso` base when it finally succeeds (`periodEndIso + 30d`), which matches provider behavior of billing for the elapsed period.
- [ ] Run `pnpm --filter @paperclipai/plugin-billing typecheck`.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/provider packages/plugins/plugin-billing/tests/stub-provider.spec.ts
git commit -m "feat(plugin-billing): spec-verbatim provider port and fully functional HMAC-signed stub provider

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 11: Ledger applier + webhook handler

**Files:**
- Create: `packages/plugins/plugin-billing/src/apply.ts`
- Create: `packages/plugins/plugin-billing/src/webhook.ts`
- Test: `packages/plugins/plugin-billing/tests/webhook.spec.ts`

**Interfaces:**
- Consumes: `transition`/`expectedStanding` (Task 6), `BillingStore` (Task 7), `StandingWriter` (Task 5), `BillingProvider` (Task 10).
- Produces:

```ts
// apply.ts
export interface ApplyDeps { store: BillingStore; config: BillingConfig; standing: StandingWriter; provider: BillingProvider; logger: Pick<PluginLogger, "warn">; now: () => Date; }
export async function applyBillingEvent(deps: ApplyDeps, sub: SubscriptionRow, event: BillingEvent, ledgerId: string): Promise<SubscriptionRow>;
export function billingEventFromLedger(row: LedgerRow): BillingEvent | null; // null for bookkeeping rows
// webhook.ts
export function ledgerKeyForRawBody(rawBody: string): string; // `webhook:${sha256hex(rawBody)}`
export function toBillingEvent(parsed: ParsedProviderEvent): BillingEvent;
export async function resolveSubscriptionForEvent(store: BillingStore, parsed: ParsedProviderEvent, rawPayload: Record<string, unknown>): Promise<SubscriptionRow | null>;
export async function handleProviderWebhook(deps: ApplyDeps, input: { headers: Record<string, string | string[]>; rawBody: string }): Promise<void>;
```

- Pipeline order (spec §5/§8): verify (throw ⇒ host answers non-2xx, delivery `failed`, zero state change) → ledger insert (unique `idempotency_key` = `webhook:sha256(rawBody)`; duplicate ⇒ return, replay no-op) → transition → mark applied → provider effects → standing write (failure logged; sweep reconciles).
- Resolution order: `sessionRef` (checkout.completed) → `providerSubscriptionId` → `rawPayload.companyId`. Unresolvable events stay in the ledger unapplied; the sweep replays them once resolvable (this is how out-of-order delivery is safe).

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/webhook.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { STUB_SIGNATURE_HEADER } from "../src/constants.js";
import { DEFAULT_BILLING_CONFIG } from "../src/config.js";
import type { SubscriptionRow } from "../src/domain.js";
import { WebhookVerificationError, signStubPayload } from "../src/hmac.js";
import { MemoryStubStateStore, StubProvider } from "../src/provider/stub.js";
import { applyBillingEvent, billingEventFromLedger, type ApplyDeps } from "../src/apply.js";
import { handleProviderWebhook, ledgerKeyForRawBody } from "../src/webhook.js";
import { MemoryBillingStore } from "../src/store-memory.js";

const SECRET = "b".repeat(64);
const NOW = new Date("2026-07-18T12:00:00.000Z");

function mkSub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1", companyId: "co-1", ownerUserId: "user-1", customerId: null,
    status: "awaiting_payment", trialEndsAt: null, graceSince: null, currentPeriodEnd: null,
    cancelAtPeriodEnd: false, priceCentsOverride: null, providerSubscriptionId: null,
    openCheckoutSessionRef: null, openCheckoutUrl: null,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ApplyDeps> = {}) {
  const store = new MemoryBillingStore(() => NOW);
  const standingCalls: Array<Record<string, unknown>> = [];
  const provider = new StubProvider({
    store: new MemoryStubStateStore(),
    secret: SECRET,
    transport: { deliver: async () => {} },
    now: () => NOW,
  });
  const warn = vi.fn();
  const deps: ApplyDeps = {
    store,
    config: DEFAULT_BILLING_CONFIG,
    standing: {
      set: async (companyId, input) => { standingCalls.push({ kind: "set", companyId, ...input }); },
      clear: async (companyId) => { standingCalls.push({ kind: "clear", companyId }); },
    },
    provider,
    logger: { warn },
    now: () => NOW,
    ...overrides,
  };
  return { deps, store, standingCalls, warn };
}

function signedEvent(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return { rawBody, headers: { [STUB_SIGNATURE_HEADER]: signStubPayload(SECRET, rawBody) } };
}

describe("handleProviderWebhook", () => {
  it("rejects a bad signature: throws, writes NO ledger row, changes NO state", async () => {
    const { deps, store, standingCalls } = makeDeps();
    await store.insertSubscription(mkSub());
    const rawBody = JSON.stringify({ eventId: "e", type: "payment.failed", subRef: "psub-1" });
    await expect(
      handleProviderWebhook(deps, { headers: { [STUB_SIGNATURE_HEADER]: "00" }, rawBody }),
    ).rejects.toThrow(WebhookVerificationError);
    expect(await store.listUnappliedLedgerEvents(10)).toEqual([]);
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("awaiting_payment");
    expect(standingCalls).toEqual([]);
  });

  it("applies checkout.completed resolved via open session ref: ledger applied, status active, standing cleared", async () => {
    const { deps, store, standingCalls } = makeDeps();
    await store.insertSubscription(mkSub({ status: "blocked", openCheckoutSessionRef: "sess-1", openCheckoutUrl: "u" }));
    const { rawBody, headers } = signedEvent({
      eventId: "e1", type: "checkout.completed", sessionRef: "sess-1", subRef: "psub-1",
      periodEnd: "2026-08-17T12:00:00.000Z", companyId: "co-1",
    });
    await handleProviderWebhook(deps, { headers, rawBody });
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.status).toBe("active");
    expect(sub.providerSubscriptionId).toBe("psub-1");
    expect(sub.openCheckoutSessionRef).toBeNull();
    expect(await store.listUnappliedLedgerEvents(10)).toEqual([]);
    expect(standingCalls).toEqual([{ kind: "clear", companyId: "co-1" }]);
  });

  it("replay of the byte-identical body is a no-op (single ledger row, no second standing write)", async () => {
    const { deps, store, standingCalls } = makeDeps();
    await store.insertSubscription(mkSub({ openCheckoutSessionRef: "sess-1" }));
    const { rawBody, headers } = signedEvent({
      eventId: "e1", type: "checkout.completed", sessionRef: "sess-1", subRef: "psub-1",
      periodEnd: "2026-08-17T12:00:00.000Z", companyId: "co-1",
    });
    await handleProviderWebhook(deps, { headers, rawBody });
    await handleProviderWebhook(deps, { headers, rawBody });
    expect(standingCalls).toHaveLength(1);
    const history = await store.listLedgerEventsForCompany("co-1", 10);
    expect(history.filter((row) => row.idempotencyKey === ledgerKeyForRawBody(rawBody))).toHaveLength(1);
  });

  it("out-of-order: an unresolvable payment.succeeded is stored unapplied and mutates nothing", async () => {
    const { deps, store, warn } = makeDeps();
    await store.insertSubscription(mkSub());
    const { rawBody, headers } = signedEvent({
      eventId: "e1", type: "payment.succeeded", subRef: "psub-unknown", periodEnd: "2026-09-17T12:00:00.000Z",
    });
    await handleProviderWebhook(deps, { headers, rawBody });
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("awaiting_payment");
    const unapplied = await store.listUnappliedLedgerEvents(10);
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].type).toBe("payment.succeeded");
    expect(warn).toHaveBeenCalled();
  });

  it("falls back to rawPayload.companyId when the subRef is not yet known (one-click first event)", async () => {
    const { deps, store } = makeDeps();
    await store.insertSubscription(mkSub());
    const { rawBody, headers } = signedEvent({
      eventId: "e1", type: "payment.succeeded", subRef: "psub-2", periodEnd: "2026-08-17T12:00:00.000Z", companyId: "co-1",
    });
    await handleProviderWebhook(deps, { headers, rawBody });
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.status).toBe("active");
    expect(sub.providerSubscriptionId).toBe("psub-2");
  });

  it("standing-write failure does not lose the transition: sub updated, ledger applied, warning logged", async () => {
    const failing = makeDeps({
      standing: {
        set: async () => { throw new Error("standing service down"); },
        clear: async () => { throw new Error("standing service down"); },
      },
    });
    await failing.store.insertSubscription(mkSub({ openCheckoutSessionRef: "sess-1" }));
    const { rawBody, headers } = signedEvent({
      eventId: "e1", type: "checkout.completed", sessionRef: "sess-1", subRef: "psub-1",
      periodEnd: "2026-08-17T12:00:00.000Z", companyId: "co-1",
    });
    await handleProviderWebhook(failing.deps, { headers, rawBody });
    expect((await failing.store.getSubscriptionByCompany("co-1"))!.status).toBe("active");
    expect(await failing.store.listUnappliedLedgerEvents(10)).toEqual([]);
    expect(failing.warn).toHaveBeenCalled();
  });
});

describe("applyBillingEvent — provider effects", () => {
  it("admin comp (override 0) cancels the live provider subscription via cancelNow", async () => {
    const { deps, store } = makeDeps();
    const cancelNow = vi.spyOn(deps.provider, "cancelNow").mockResolvedValue();
    await store.insertSubscription(mkSub({ status: "active", providerSubscriptionId: "psub-1" }));
    await store.insertLedgerEvent({ id: "led-1", idempotencyKey: "admin:1", type: "admin.set_price_override", subscriptionId: "sub-1", companyId: "co-1", rawPayload: { priceCents: 0 } });
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    const next = await applyBillingEvent(deps, sub, { type: "admin.set_price_override", priceCents: 0 }, "led-1");
    expect(next.status).toBe("complimentary");
    expect(cancelNow).toHaveBeenCalledExactlyOnceWith("psub-1");
    expect(await store.listUnappliedLedgerEvents(10)).toEqual([]);
  });

  it("a cancelNow provider outage is logged but never blocks the local transition", async () => {
    const { deps, store, warn } = makeDeps();
    vi.spyOn(deps.provider, "cancelNow").mockRejectedValue(new Error("provider down"));
    await store.insertSubscription(mkSub({ status: "active", providerSubscriptionId: "psub-1" }));
    await store.insertLedgerEvent({ id: "led-1", idempotencyKey: "del:1", type: "company.deleted", subscriptionId: "sub-1", companyId: "co-1", rawPayload: {} });
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    const next = await applyBillingEvent(deps, sub, { type: "company.deleted" }, "led-1");
    expect(next.status).toBe("canceled");
    expect(warn).toHaveBeenCalled();
  });
});

describe("billingEventFromLedger", () => {
  it("reconstructs webhook and internal events from ledger rows", () => {
    const base = { id: "x", idempotencyKey: "k", subscriptionId: null, companyId: "co-1", appliedAt: null, createdAt: "2026-07-18T00:00:00.000Z" };
    expect(billingEventFromLedger({ ...base, type: "checkout.completed", rawPayload: { sessionRef: "s", subRef: "p", periodEnd: "2026-08-01T00:00:00.000Z" } }))
      .toEqual({ type: "checkout.completed", sessionRef: "s", subRef: "p", periodEnd: "2026-08-01T00:00:00.000Z" });
    expect(billingEventFromLedger({ ...base, type: "payment.succeeded", rawPayload: { subRef: "p", periodEnd: "2026-08-01T00:00:00.000Z" } }))
      .toEqual({ type: "payment.succeeded", subRef: "p", periodEnd: "2026-08-01T00:00:00.000Z" });
    expect(billingEventFromLedger({ ...base, type: "payment.failed", rawPayload: { subRef: "p" } }))
      .toEqual({ type: "payment.failed", subRef: "p" });
    expect(billingEventFromLedger({ ...base, type: "subscription.canceled", rawPayload: { subRef: "p" } }))
      .toEqual({ type: "subscription.canceled", subRef: "p" });
    expect(billingEventFromLedger({ ...base, type: "one_click.activated", rawPayload: { subRef: null, periodEnd: "2026-08-01T00:00:00.000Z" } }))
      .toEqual({ type: "one_click.activated", subRef: null, periodEnd: "2026-08-01T00:00:00.000Z" });
    expect(billingEventFromLedger({ ...base, type: "admin.set_price_override", rawPayload: { priceCents: 0 } }))
      .toEqual({ type: "admin.set_price_override", priceCents: 0 });
    expect(billingEventFromLedger({ ...base, type: "admin.extend_trial", rawPayload: { trialEndsAt: "2026-08-01T00:00:00.000Z" } }))
      .toEqual({ type: "admin.extend_trial", trialEndsAt: "2026-08-01T00:00:00.000Z" });
    expect(billingEventFromLedger({ ...base, type: "owner.cancel_at_period_end", rawPayload: {} }))
      .toEqual({ type: "owner.cancel_at_period_end" });
    expect(billingEventFromLedger({ ...base, type: "owner.resume", rawPayload: {} })).toEqual({ type: "owner.resume" });
    expect(billingEventFromLedger({ ...base, type: "company.deleted", rawPayload: {} })).toEqual({ type: "company.deleted" });
    expect(billingEventFromLedger({ ...base, type: "clock", rawPayload: {} })).toEqual({ type: "clock" });
    // bookkeeping rows never transition
    for (const type of ["subscription.created", "trial.started", "checkout.created"]) {
      expect(billingEventFromLedger({ ...base, type, rawPayload: {} })).toBeNull();
    }
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/webhook.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/apply.ts`:

```ts
import type { PluginLogger } from "@paperclipai/plugin-sdk";
import type { BillingConfig } from "./config.js";
import type { BillingEvent, LedgerRow, SubscriptionRow } from "./domain.js";
import type { BillingProvider } from "./provider/types.js";
import { applyStandingCommand, type StandingWriter } from "./standing.js";
import { expectedStanding, transition } from "./state-machine.js";
import type { BillingStore } from "./store.js";

export interface ApplyDeps {
  store: BillingStore;
  config: BillingConfig;
  standing: StandingWriter;
  provider: BillingProvider;
  logger: Pick<PluginLogger, "warn">;
  now: () => Date;
}

/**
 * The one code path that mutates a subscription:
 * transition (pure) → persist → mark ledger applied → provider effects →
 * standing write. Standing is deliberately last and non-fatal: on failure the
 * sweep reconciles standing from subscription state (spec §8).
 */
export async function applyBillingEvent(
  deps: ApplyDeps,
  sub: SubscriptionRow,
  event: BillingEvent,
  ledgerId: string,
): Promise<SubscriptionRow> {
  const now = deps.now();
  const result = transition(sub, event, deps.config, now);

  if (result.changed) {
    await deps.store.updateSubscription(result.sub);
  }
  await deps.store.markLedgerApplied(ledgerId, now.toISOString());

  for (const effect of result.effects) {
    try {
      await deps.provider.cancelNow(effect.providerSubscriptionId);
    } catch (error) {
      deps.logger.warn("billing: provider cancelNow failed (will not retry automatically)", {
        companyId: result.sub.companyId,
        providerSubscriptionId: effect.providerSubscriptionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    await applyStandingCommand(deps.standing, result.sub.companyId, expectedStanding(result.sub, deps.config));
  } catch (error) {
    deps.logger.warn("billing: standing write failed; the sweep will reconcile", {
      companyId: result.sub.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result.sub;
}

/** Reconstruct the state-machine event from a ledger row; null for bookkeeping rows. */
export function billingEventFromLedger(row: LedgerRow): BillingEvent | null {
  const raw = row.rawPayload;
  switch (row.type) {
    case "checkout.completed":
      return { type: "checkout.completed", sessionRef: String(raw.sessionRef), subRef: String(raw.subRef), periodEnd: String(raw.periodEnd) };
    case "payment.succeeded":
      return { type: "payment.succeeded", subRef: String(raw.subRef), periodEnd: String(raw.periodEnd) };
    case "payment.failed":
      return { type: "payment.failed", subRef: String(raw.subRef) };
    case "subscription.canceled":
      return { type: "subscription.canceled", subRef: String(raw.subRef) };
    case "one_click.activated":
      return { type: "one_click.activated", subRef: raw.subRef == null ? null : String(raw.subRef), periodEnd: String(raw.periodEnd) };
    case "owner.cancel_at_period_end":
      return { type: "owner.cancel_at_period_end" };
    case "owner.resume":
      return { type: "owner.resume" };
    case "admin.set_price_override":
      return { type: "admin.set_price_override", priceCents: raw.priceCents == null ? null : Number(raw.priceCents) };
    case "admin.extend_trial":
      return { type: "admin.extend_trial", trialEndsAt: String(raw.trialEndsAt) };
    case "company.deleted":
      return { type: "company.deleted" };
    case "clock":
      return { type: "clock" };
    default:
      return null; // bookkeeping rows: subscription.created, trial.started, checkout.created
  }
}
```

- [ ] Create `packages/plugins/plugin-billing/src/webhook.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { applyBillingEvent, type ApplyDeps } from "./apply.js";
import type { BillingEvent, SubscriptionRow } from "./domain.js";
import type { ParsedProviderEvent } from "./provider/types.js";
import type { BillingStore } from "./store.js";

/**
 * Idempotency key derived from the exact signed bytes: a provider replay is
 * byte-identical, so it hashes to the same key and the ledger insert reports
 * "duplicate" (spec §5 rules). The parsed-event union deliberately carries no
 * event id, so the raw body is the only stable identity.
 */
export function ledgerKeyForRawBody(rawBody: string): string {
  return `webhook:${createHash("sha256").update(rawBody, "utf8").digest("hex")}`;
}

export function toBillingEvent(parsed: ParsedProviderEvent): BillingEvent {
  switch (parsed.type) {
    case "checkout.completed":
      return { type: "checkout.completed", sessionRef: parsed.sessionRef, subRef: parsed.subRef, periodEnd: parsed.periodEnd };
    case "payment.succeeded":
      return { type: "payment.succeeded", subRef: parsed.subRef, periodEnd: parsed.periodEnd };
    case "payment.failed":
      return { type: "payment.failed", subRef: parsed.subRef };
    case "subscription.canceled":
      return { type: "subscription.canceled", subRef: parsed.subRef };
  }
}

/** Resolution order: open session ref → provider subscription ref → rawPayload.companyId. */
export async function resolveSubscriptionForEvent(
  store: BillingStore,
  parsed: ParsedProviderEvent,
  rawPayload: Record<string, unknown>,
): Promise<SubscriptionRow | null> {
  if (parsed.type === "checkout.completed") {
    const bySession = await store.getSubscriptionBySessionRef(parsed.sessionRef);
    if (bySession) return bySession;
  }
  const byRef = await store.getSubscriptionByProviderRef(parsed.subRef);
  if (byRef) return byRef;
  if (typeof rawPayload.companyId === "string" && rawPayload.companyId.length > 0) {
    return store.getSubscriptionByCompany(rawPayload.companyId);
  }
  return null;
}

/**
 * verify → ledger insert → transition → standing. Throwing before the ledger
 * insert (bad signature) makes the host record the delivery as failed with a
 * non-2xx response and changes no state. Any crash after the insert leaves an
 * unapplied ledger row that the sweep replays idempotently (spec §8).
 */
export async function handleProviderWebhook(
  deps: ApplyDeps,
  input: { headers: Record<string, string | string[]>; rawBody: string },
): Promise<void> {
  const parsed = deps.provider.verifyAndParseWebhook(input.headers, input.rawBody);

  let rawPayload: Record<string, unknown>;
  try {
    rawPayload = JSON.parse(input.rawBody) as Record<string, unknown>;
  } catch {
    rawPayload = { rawBody: input.rawBody };
  }

  const sub = await resolveSubscriptionForEvent(deps.store, parsed, rawPayload);
  const ledgerId = randomUUID();
  const inserted = await deps.store.insertLedgerEvent({
    id: ledgerId,
    idempotencyKey: ledgerKeyForRawBody(input.rawBody),
    type: parsed.type,
    subscriptionId: sub?.id ?? null,
    companyId: sub?.companyId ?? null,
    rawPayload,
  });
  if (inserted === "duplicate") return;

  if (!sub) {
    deps.logger.warn("billing: webhook event has no resolvable subscription yet; left unapplied for the sweep", {
      type: parsed.type,
    });
    return;
  }

  await applyBillingEvent(deps, sub, toBillingEvent(parsed), ledgerId);
}
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/webhook.spec.ts` — expect all passing.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/apply.ts packages/plugins/plugin-billing/src/webhook.ts packages/plugins/plugin-billing/tests/webhook.spec.ts
git commit -m "feat(plugin-billing): ledger-first webhook pipeline with idempotent replay and crash recovery

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: Company creation matrix + company.created handler

**Files:**
- Create: `packages/plugins/plugin-billing/src/creation.ts`
- Test: `packages/plugins/plugin-billing/tests/creation.spec.ts`

**Interfaces:**
- Consumes: `BillingStore`, `StandingWriter`, config; `ctx.access.members.list` + `Company.defaultResponsibleUserId` for owner resolution (there is no owner field on `Company`; owner = active `user` membership with `membershipRole === "owner"`, as created by `server/src/routes/companies.ts:403`).
- Produces:

```ts
export function initialSubscription(input: { id: string; companyId: string; ownerUserId: string; ownerHadTrial: boolean; priceCentsOverride?: number | null }, config: BillingConfig, now: Date): SubscriptionRow;
export interface OwnerResolver { resolveOwnerUserId(companyId: string): Promise<string>; }
export function ownerResolverFromContext(ctx: PluginContext): OwnerResolver;
export async function ensureSubscriptionForCompany(deps: ApplyDeps & { owners: OwnerResolver }, companyId: string): Promise<SubscriptionRow>; // idempotent rowless pickup, used by event handler AND sweep
```

- Creation matrix (spec §6.1): `trialPolicy === "none"` ⇒ `awaiting_payment`; `"every-company"` ⇒ `trialing`; `"first-company-per-owner"` ⇒ `trialing` iff `!ownerHadTrial` (ledger-checked — deleting the trial company does NOT reset eligibility) else `awaiting_payment`. `priceCentsOverride === 0` ⇒ `complimentary` (admin-seeded rows only). Ledger bookkeeping rows: `subscription.created` (key `sub-created:<companyId>`) and, when trialing, `trial.started` (key `trial-started:<companyId>`, payload `{ ownerUserId, companyId, trialEndsAt }`), both marked applied immediately (they carry no transition).

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/creation.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BILLING_CONFIG } from "../src/config.js";
import { MemoryStubStateStore, StubProvider } from "../src/provider/stub.js";
import { ensureSubscriptionForCompany, initialSubscription } from "../src/creation.js";
import { MemoryBillingStore } from "../src/store-memory.js";
import type { ApplyDeps } from "../src/apply.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");
const CONFIG = DEFAULT_BILLING_CONFIG;

describe("initialSubscription — creation matrix", () => {
  const base = { id: "sub-1", companyId: "co-1", ownerUserId: "user-1", ownerHadTrial: false };

  it("owner's first company with first-company-per-owner policy → trialing with trial_ends_at = now + trialDays", () => {
    const sub = initialSubscription(base, CONFIG, NOW);
    expect(sub.status).toBe("trialing");
    expect(sub.trialEndsAt).toBe("2026-07-25T12:00:00.000Z");
  });

  it("owner already used a trial → awaiting_payment", () => {
    const sub = initialSubscription({ ...base, ownerHadTrial: true }, CONFIG, NOW);
    expect(sub.status).toBe("awaiting_payment");
    expect(sub.trialEndsAt).toBeNull();
  });

  it("trialPolicy none → awaiting_payment even for a first company", () => {
    const sub = initialSubscription(base, { ...CONFIG, trialPolicy: "none" }, NOW);
    expect(sub.status).toBe("awaiting_payment");
  });

  it("trialPolicy every-company → trialing even after a previous trial", () => {
    const sub = initialSubscription({ ...base, ownerHadTrial: true }, { ...CONFIG, trialPolicy: "every-company" }, NOW);
    expect(sub.status).toBe("trialing");
  });

  it("priceCentsOverride 0 → complimentary, no trial, no checkout ever", () => {
    const sub = initialSubscription({ ...base, priceCentsOverride: 0 }, CONFIG, NOW);
    expect(sub.status).toBe("complimentary");
    expect(sub.priceCentsOverride).toBe(0);
    expect(sub.trialEndsAt).toBeNull();
  });

  it("zero trialDays never produces a trial", () => {
    const sub = initialSubscription(base, { ...CONFIG, trialDays: 0 }, NOW);
    expect(sub.status).toBe("awaiting_payment");
  });
});

describe("ensureSubscriptionForCompany", () => {
  function makeDeps() {
    const store = new MemoryBillingStore(() => NOW);
    const standingCalls: Array<Record<string, unknown>> = [];
    const deps: ApplyDeps & { owners: { resolveOwnerUserId(companyId: string): Promise<string> } } = {
      store,
      config: CONFIG,
      standing: {
        set: async (companyId, input) => { standingCalls.push({ kind: "set", companyId, status: input.status, reason: input.reason }); },
        clear: async (companyId) => { standingCalls.push({ kind: "clear", companyId }); },
      },
      provider: new StubProvider({ store: new MemoryStubStateStore(), secret: "c".repeat(64), transport: { deliver: async () => {} }, now: () => NOW }),
      logger: { warn: vi.fn() },
      now: () => NOW,
      owners: { resolveOwnerUserId: async () => "user-1" },
    };
    return { deps, store, standingCalls };
  }

  it("creates a trialing row + both ledger rows + informational standing for a first company", async () => {
    const { deps, store, standingCalls } = makeDeps();
    const sub = await ensureSubscriptionForCompany(deps, "co-1");
    expect(sub.status).toBe("trialing");
    const events = await store.listLedgerEventsForCompany("co-1", 10);
    expect(events.map((event) => event.type).sort()).toEqual(["subscription.created", "trial.started"]);
    expect(events.every((event) => event.appliedAt !== null)).toBe(true);
    expect(await store.ownerHadTrial("user-1")).toBe(true);
    expect(standingCalls).toEqual([{ kind: "set", companyId: "co-1", status: "active", reason: "trialing" }]);
  });

  it("second company of the same owner is awaiting_payment and blocked (trial burned via ledger)", async () => {
    const { deps, store, standingCalls } = makeDeps();
    await ensureSubscriptionForCompany(deps, "co-1");
    const second = await ensureSubscriptionForCompany(deps, "co-2");
    expect(second.status).toBe("awaiting_payment");
    expect(standingCalls.at(-1)).toEqual({ kind: "set", companyId: "co-2", status: "blocked", reason: "awaiting_subscription" });
    void store;
  });

  it("is idempotent: an existing row is returned untouched (event + sweep race safety)", async () => {
    const { deps, store } = makeDeps();
    const first = await ensureSubscriptionForCompany(deps, "co-1");
    const again = await ensureSubscriptionForCompany(deps, "co-1");
    expect(again.id).toBe(first.id);
    expect((await store.listLedgerEventsForCompany("co-1", 10))).toHaveLength(2);
  });

  it("trial eligibility survives company deletion: ledger row remains even if the sub row vanished", async () => {
    const { deps, store } = makeDeps();
    await ensureSubscriptionForCompany(deps, "co-1");
    // simulate the trial company being deleted: sub row gone, ledger remains
    await store.updateSubscription({ ...(await store.getSubscriptionByCompany("co-1"))!, companyId: "co-deleted" });
    const second = await ensureSubscriptionForCompany(deps, "co-2");
    expect(second.status).toBe("awaiting_payment");
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/creation.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/creation.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ApplyDeps } from "./apply.js";
import type { BillingConfig } from "./config.js";
import type { SubscriptionRow } from "./domain.js";
import { addDaysIso, expectedStanding } from "./state-machine.js";
import { applyStandingCommand } from "./standing.js";

/** Pure creation matrix (spec §6.1). */
export function initialSubscription(
  input: { id: string; companyId: string; ownerUserId: string; ownerHadTrial: boolean; priceCentsOverride?: number | null },
  config: BillingConfig,
  now: Date,
): SubscriptionRow {
  const nowIso = now.toISOString();
  const priceCentsOverride = input.priceCentsOverride ?? null;

  let status: SubscriptionRow["status"];
  let trialEndsAt: string | null = null;
  if (priceCentsOverride === 0) {
    status = "complimentary";
  } else {
    const trialAllowed = config.trialDays > 0
      && (config.trialPolicy === "every-company"
        || (config.trialPolicy === "first-company-per-owner" && !input.ownerHadTrial));
    if (trialAllowed) {
      status = "trialing";
      trialEndsAt = addDaysIso(nowIso, config.trialDays);
    } else {
      status = "awaiting_payment";
    }
  }

  return {
    id: input.id,
    companyId: input.companyId,
    ownerUserId: input.ownerUserId,
    customerId: null,
    status,
    trialEndsAt,
    graceSince: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    priceCentsOverride,
    providerSubscriptionId: null,
    openCheckoutSessionRef: null,
    openCheckoutUrl: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export interface OwnerResolver {
  resolveOwnerUserId(companyId: string): Promise<string>;
}

/**
 * Owner = active `user` membership with membershipRole "owner"
 * (created by the company-create route), falling back to
 * company.defaultResponsibleUserId, then "local-board" (local_trusted mode).
 */
export function ownerResolverFromContext(ctx: PluginContext): OwnerResolver {
  return {
    async resolveOwnerUserId(companyId: string): Promise<string> {
      try {
        const members = await ctx.access.members.list({ companyId });
        const owner = members.find(
          (member) => member.principalType === "user" && member.membershipRole === "owner" && member.status === "active",
        );
        if (owner) return owner.principalId;
      } catch {
        // access read unavailable — fall through to company metadata
      }
      const company = await ctx.companies.get(companyId);
      return company?.defaultResponsibleUserId ?? "local-board";
    },
  };
}

/**
 * Rowless-company pickup, used by both the company.created event handler and
 * the sweep (event-loss safety). Idempotent per company.
 */
export async function ensureSubscriptionForCompany(
  deps: ApplyDeps & { owners: OwnerResolver },
  companyId: string,
): Promise<SubscriptionRow> {
  const existing = await deps.store.getSubscriptionByCompany(companyId);
  if (existing) return existing;

  const now = deps.now();
  const ownerUserId = await deps.owners.resolveOwnerUserId(companyId);
  const ownerHadTrial = await deps.store.ownerHadTrial(ownerUserId);
  const sub = initialSubscription({ id: randomUUID(), companyId, ownerUserId, ownerHadTrial }, deps.config, now);

  await deps.store.insertSubscription(sub);

  const createdLedgerId = randomUUID();
  await deps.store.insertLedgerEvent({
    id: createdLedgerId,
    idempotencyKey: `sub-created:${companyId}`,
    type: "subscription.created",
    subscriptionId: sub.id,
    companyId,
    rawPayload: { ownerUserId, status: sub.status },
  });
  await deps.store.markLedgerApplied(createdLedgerId, now.toISOString());

  if (sub.status === "trialing") {
    const trialLedgerId = randomUUID();
    await deps.store.insertLedgerEvent({
      id: trialLedgerId,
      idempotencyKey: `trial-started:${companyId}`,
      type: "trial.started",
      subscriptionId: sub.id,
      companyId,
      rawPayload: { ownerUserId, companyId, trialEndsAt: sub.trialEndsAt },
    });
    await deps.store.markLedgerApplied(trialLedgerId, now.toISOString());
  }

  try {
    await applyStandingCommand(deps.standing, companyId, expectedStanding(sub, deps.config));
  } catch (error) {
    deps.logger.warn("billing: initial standing write failed; the sweep will reconcile", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return sub;
}
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/creation.spec.ts` — expect all passing.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/creation.ts packages/plugins/plugin-billing/tests/creation.spec.ts
git commit -m "feat(plugin-billing): creation matrix with ledger-backed trial eligibility

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 13: billing-sweep

**Files:**
- Create: `packages/plugins/plugin-billing/src/sweep.ts`
- Test: `packages/plugins/plugin-billing/tests/sweep.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–12.
- Produces:

```ts
export interface SweepDeps extends ApplyDeps {
  owners: OwnerResolver;
  companies: { list(): Promise<Array<{ id: string; status: string }>> }; // adapter over ctx.companies.list()
  stub?: { deliverDue(now: Date): Promise<number> };                     // present when provider === "stub"
}
export interface SweepReport { stubDelivered: number; replayedLedger: number; createdRows: number; deletedCompanyCancels: number; clockTransitions: number; expiredCheckouts: number; standingsReconciled: number; }
export async function runBillingSweep(deps: SweepDeps): Promise<SweepReport>;
```

Sweep phases, in order (each phase failure-isolated with try/catch per item so one bad row never stops reconciliation):
1. **Stub due deliveries** — renewals, dunning retries, failed-transport redeliveries (`stub.deliverDue(now)`). In production the deliveries HTTP-POST back to this instance's webhook route; the worker handles that RPC concurrently on the event loop.
2. **Unapplied-ledger replay** — `listUnappliedLedgerEvents(200)`; reconstruct via `billingEventFromLedger`; resolve via `companyId` on the row, else `resolveSubscriptionForEvent` semantics from the payload; apply. Still-unresolvable rows stay for the next sweep. This recovers post-insert crashes AND out-of-order webhook arrivals (spec §8, §9).
3. **Rowless pickup** — every non-archived company without a `subscriptions` row gets one per the creation matrix (event-loss safety; also first-install backfill).
4. **Deleted-company cancels** — subscriptions whose company no longer exists ⇒ `company.deleted` event (ledger key `company-deleted:<companyId>`), which cancels locally and `cancelNow`s at the provider ("never bill a ghost").
5. **Clock transitions** — for each remaining sub, dry-run `transition(sub, {type:"clock"})`; if it would change, insert ledger row (key `clock:<subId>:<fromStatus>:<toStatus>:<YYYY-MM-DD>` — idempotent per day) and apply. All time math is pure in `now` (clock-skew safe).
6. **Stuck-checkout reconciliation** — for subs with an `openCheckoutSessionRef`: provider `resolveCheckout` says `"expired"` ⇒ clear ref+url (bookkeeping ledger row `checkout-expired:<sessionRef>`); `"complete"` needs no action here (the completed event is recovered by phases 1–2); `"open"` is left alone.
7. **Standing reconciliation** — re-apply `expectedStanding` for every sub whose company still exists (idempotent; converges standing after any missed write).

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/sweep.spec.ts`:

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BILLING_CONFIG } from "../src/config.js";
import { MemoryStubStateStore, StubProvider } from "../src/provider/stub.js";
import { handleProviderWebhook } from "../src/webhook.js";
import { runBillingSweep, type SweepDeps } from "../src/sweep.js";
import { MemoryBillingStore } from "../src/store-memory.js";
import type { SubscriptionRow } from "../src/domain.js";

const SECRET = "d".repeat(64);
const NOW = new Date("2026-07-18T12:00:00.000Z");
const DAY = 86_400_000;

function harness(companies: Array<{ id: string; status: string }>) {
  const store = new MemoryBillingStore(() => NOW);
  const standingCalls: Array<Record<string, unknown>> = [];
  let now = NOW;

  // transport loops stub events straight back into the webhook pipeline
  const provider: StubProvider = new StubProvider({
    store: new MemoryStubStateStore(),
    secret: SECRET,
    transport: {
      deliver: (headers, rawBody) => handleProviderWebhook(deps, { headers, rawBody }),
    },
    now: () => now,
  });

  const deps: SweepDeps = {
    store,
    config: DEFAULT_BILLING_CONFIG,
    standing: {
      set: async (companyId, input) => { standingCalls.push({ kind: "set", companyId, status: input.status, reason: input.reason }); },
      clear: async (companyId) => { standingCalls.push({ kind: "clear", companyId }); },
    },
    provider,
    logger: { warn: vi.fn() },
    now: () => now,
    owners: { resolveOwnerUserId: async (companyId) => `owner-of-${companyId}` },
    companies: { list: async () => companies },
    stub: provider,
  };
  return { deps, store, standingCalls, provider, setNow: (d: Date) => { now = d; } };
}

function mkSub(overrides: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    id: randomUUID(), companyId: "co-1", ownerUserId: "user-1", customerId: null,
    status: "awaiting_payment", trialEndsAt: null, graceSince: null, currentPeriodEnd: null,
    cancelAtPeriodEnd: false, priceCentsOverride: null, providerSubscriptionId: null,
    openCheckoutSessionRef: null, openCheckoutUrl: null,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("runBillingSweep", () => {
  it("creates rows for rowless non-archived companies only", async () => {
    const { deps, store } = harness([
      { id: "co-1", status: "active" },
      { id: "co-2", status: "archived" },
    ]);
    const report = await runBillingSweep(deps);
    expect(report.createdRows).toBe(1);
    expect(await store.getSubscriptionByCompany("co-1")).not.toBeNull();
    expect(await store.getSubscriptionByCompany("co-2")).toBeNull();
  });

  it("applies clock transitions with a per-day idempotent ledger row", async () => {
    const { deps, store } = harness([{ id: "co-1", status: "active" }]);
    await store.insertSubscription(mkSub({ status: "trialing", trialEndsAt: new Date(NOW.getTime() - DAY).toISOString() }));
    const first = await runBillingSweep(deps);
    expect(first.clockTransitions).toBe(1);
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("grace");
    const second = await runBillingSweep(deps); // same day, same target state
    expect(second.clockTransitions).toBe(0);
  });

  it("walks trial → grace → blocked across two sweep days and reconciles standing each time", async () => {
    const { deps, store, standingCalls, setNow } = harness([{ id: "co-1", status: "active" }]);
    await store.insertSubscription(mkSub({ status: "trialing", trialEndsAt: new Date(NOW.getTime() - DAY).toISOString() }));
    await runBillingSweep(deps);
    expect(standingCalls.at(-1)).toMatchObject({ kind: "set", status: "grace", reason: "trial_ended" });
    setNow(new Date(NOW.getTime() + DEFAULT_BILLING_CONFIG.graceDays * DAY));
    await runBillingSweep(deps);
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("blocked");
    expect(standingCalls.at(-1)).toMatchObject({ kind: "set", status: "blocked", reason: "trial_ended" });
  });

  it("cancels subscriptions of deleted companies locally and at the provider", async () => {
    const { deps, store } = harness([{ id: "co-live", status: "active" }]);
    const cancelNow = vi.spyOn(deps.provider, "cancelNow").mockResolvedValue();
    await store.insertSubscription(mkSub({ companyId: "co-live", status: "active", providerSubscriptionId: "psub-live" }));
    await store.insertSubscription(mkSub({ companyId: "co-gone", status: "active", providerSubscriptionId: "psub-gone" }));
    const report = await runBillingSweep(deps);
    expect(report.deletedCompanyCancels).toBe(1);
    expect((await store.getSubscriptionByCompany("co-gone"))!.status).toBe("canceled");
    expect(cancelNow).toHaveBeenCalledExactlyOnceWith("psub-gone");
    expect((await store.getSubscriptionByCompany("co-live"))!.status).toBe("active");
  });

  it("replays unapplied ledger events once they become resolvable (out-of-order recovery)", async () => {
    const { deps, store } = harness([{ id: "co-1", status: "active" }]);
    await store.insertSubscription(mkSub({ status: "awaiting_payment" }));
    await store.insertLedgerEvent({
      id: "led-1", idempotencyKey: "webhook:x", type: "payment.succeeded",
      subscriptionId: null, companyId: null,
      rawPayload: { subRef: "psub-1", periodEnd: "2026-08-17T12:00:00.000Z", companyId: "co-1" },
    });
    const report = await runBillingSweep(deps);
    expect(report.replayedLedger).toBe(1);
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.status).toBe("active");
    expect(sub.providerSubscriptionId).toBe("psub-1");
    expect(await store.listUnappliedLedgerEvents(10)).toEqual([]);
  });

  it("clears expired stuck checkouts with a bookkeeping ledger row", async () => {
    const { deps, store } = harness([{ id: "co-1", status: "active" }]);
    await store.insertSubscription(mkSub({ openCheckoutSessionRef: "stub_sess_gone", openCheckoutUrl: "billing-checkout?session=stub_sess_gone" }));
    const report = await runBillingSweep(deps); // stub has no such session → "expired"
    expect(report.expiredCheckouts).toBe(1);
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.openCheckoutSessionRef).toBeNull();
    expect(sub.openCheckoutUrl).toBeNull();
    const events = await store.listLedgerEventsForCompany("co-1", 10);
    expect(events.some((event) => event.type === "checkout.expired")).toBe(true);
  });

  it("delivers due stub renewals through the full webhook path, extending the period", async () => {
    const { deps, store, provider, setNow } = harness([{ id: "co-1", status: "active" }]);
    // subscribe co-1 through the stub so a renewal is scheduled
    const { customerId } = await provider.ensureCustomer({ id: "user-1", email: "u@x.invalid", name: "U" });
    await store.insertSubscription(mkSub({ status: "awaiting_payment", openCheckoutSessionRef: null }));
    const { sessionRef } = await provider.createCheckout({
      customerId, companyId: "co-1", priceCents: 4900, currency: "EUR",
      successUrl: "s?session={SESSION_REF}", cancelUrl: "c",
    });
    await store.updateSubscription({ ...(await store.getSubscriptionByCompany("co-1"))!, openCheckoutSessionRef: sessionRef });
    await provider.completeCheckout(sessionRef, { savePaymentMethod: false });
    const activated = (await store.getSubscriptionByCompany("co-1"))!;
    expect(activated.status).toBe("active");

    setNow(new Date(Date.parse(activated.currentPeriodEnd!) + 1));
    const report = await runBillingSweep(deps);
    expect(report.stubDelivered).toBe(1);
    const renewed = (await store.getSubscriptionByCompany("co-1"))!;
    expect(Date.parse(renewed.currentPeriodEnd!)).toBe(Date.parse(activated.currentPeriodEnd!) + 30 * DAY);
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/sweep.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/sweep.ts`:

```ts
import { randomUUID } from "node:crypto";
import { applyBillingEvent, billingEventFromLedger, type ApplyDeps } from "./apply.js";
import type { OwnerResolver } from "./creation.js";
import { ensureSubscriptionForCompany } from "./creation.js";
import type { LedgerRow, SubscriptionRow } from "./domain.js";
import { applyStandingCommand } from "./standing.js";
import { expectedStanding, transition } from "./state-machine.js";
import type { BillingStore } from "./store.js";

export interface SweepDeps extends ApplyDeps {
  owners: OwnerResolver;
  companies: { list(): Promise<Array<{ id: string; status: string }>> };
  stub?: { deliverDue(now: Date): Promise<number> };
}

export interface SweepReport {
  stubDelivered: number;
  replayedLedger: number;
  createdRows: number;
  deletedCompanyCancels: number;
  clockTransitions: number;
  expiredCheckouts: number;
  standingsReconciled: number;
}

async function resolveForLedgerRow(store: BillingStore, row: LedgerRow): Promise<SubscriptionRow | null> {
  if (row.companyId) {
    const byCompany = await store.getSubscriptionByCompany(row.companyId);
    if (byCompany) return byCompany;
  }
  const raw = row.rawPayload;
  if (typeof raw.sessionRef === "string") {
    const bySession = await store.getSubscriptionBySessionRef(raw.sessionRef);
    if (bySession) return bySession;
  }
  if (typeof raw.subRef === "string") {
    const byRef = await store.getSubscriptionByProviderRef(raw.subRef);
    if (byRef) return byRef;
  }
  if (typeof raw.companyId === "string") {
    return store.getSubscriptionByCompany(raw.companyId);
  }
  return null;
}

/**
 * Daily reconciliation (spec §6.1, §8). Every phase is idempotent and
 * per-item failure-isolated: one broken row never stops the sweep.
 */
export async function runBillingSweep(deps: SweepDeps): Promise<SweepReport> {
  const report: SweepReport = {
    stubDelivered: 0,
    replayedLedger: 0,
    createdRows: 0,
    deletedCompanyCancels: 0,
    clockTransitions: 0,
    expiredCheckouts: 0,
    standingsReconciled: 0,
  };
  const warn = (phase: string, error: unknown, meta: Record<string, unknown> = {}) =>
    deps.logger.warn(`billing sweep: ${phase} failed`, {
      ...meta,
      error: error instanceof Error ? error.message : String(error),
    });

  // 1. stub due deliveries (renewals, dunning retries, redeliveries)
  if (deps.stub) {
    try {
      report.stubDelivered = await deps.stub.deliverDue(deps.now());
    } catch (error) {
      warn("stub deliverDue", error);
    }
  }

  // 2. unapplied ledger replay (post-insert crash + out-of-order recovery)
  for (const row of await deps.store.listUnappliedLedgerEvents(200)) {
    try {
      const event = billingEventFromLedger(row);
      if (!event) {
        await deps.store.markLedgerApplied(row.id, deps.now().toISOString());
        continue;
      }
      const sub = await resolveForLedgerRow(deps.store, row);
      if (!sub) continue; // still unresolvable — retry next sweep
      await applyBillingEvent(deps, sub, event, row.id);
      report.replayedLedger += 1;
    } catch (error) {
      warn("ledger replay", error, { ledgerId: row.id, type: row.type });
    }
  }

  const companies = await deps.companies.list();
  const liveCompanyIds = new Set(companies.map((company) => company.id));

  // 3. rowless pickup (event-loss safety + first-install backfill)
  for (const company of companies) {
    if (company.status === "archived") continue;
    try {
      const existing = await deps.store.getSubscriptionByCompany(company.id);
      if (existing) continue;
      await ensureSubscriptionForCompany(deps, company.id);
      report.createdRows += 1;
    } catch (error) {
      warn("rowless pickup", error, { companyId: company.id });
    }
  }

  // 4. deleted companies — never bill a ghost
  for (const sub of await deps.store.listSubscriptions()) {
    if (liveCompanyIds.has(sub.companyId) || sub.status === "canceled") continue;
    try {
      const ledgerId = randomUUID();
      const inserted = await deps.store.insertLedgerEvent({
        id: ledgerId,
        idempotencyKey: `company-deleted:${sub.companyId}`,
        type: "company.deleted",
        subscriptionId: sub.id,
        companyId: sub.companyId,
        rawPayload: {},
      });
      if (inserted === "duplicate") continue;
      await applyBillingEvent(deps, sub, { type: "company.deleted" }, ledgerId);
      report.deletedCompanyCancels += 1;
    } catch (error) {
      warn("deleted-company cancel", error, { companyId: sub.companyId });
    }
  }

  // 5. clock transitions + 6. stuck checkouts + 7. standing reconciliation
  for (const sub of await deps.store.listSubscriptions()) {
    if (!liveCompanyIds.has(sub.companyId)) continue;
    let current = sub;

    try {
      const dryRun = transition(current, { type: "clock" }, deps.config, deps.now());
      if (dryRun.changed) {
        const day = deps.now().toISOString().slice(0, 10);
        const ledgerId = randomUUID();
        const inserted = await deps.store.insertLedgerEvent({
          id: ledgerId,
          idempotencyKey: `clock:${current.id}:${current.status}:${dryRun.sub.status}:${day}`,
          type: "clock",
          subscriptionId: current.id,
          companyId: current.companyId,
          rawPayload: { from: current.status, to: dryRun.sub.status },
        });
        if (inserted === "inserted") {
          current = await applyBillingEvent(deps, current, { type: "clock" }, ledgerId);
          report.clockTransitions += 1;
        }
      }
    } catch (error) {
      warn("clock transition", error, { companyId: current.companyId });
    }

    try {
      if (current.openCheckoutSessionRef && deps.provider.resolveCheckout) {
        const state = await deps.provider.resolveCheckout(current.openCheckoutSessionRef);
        if (state === "expired") {
          const ledgerId = randomUUID();
          await deps.store.insertLedgerEvent({
            id: ledgerId,
            idempotencyKey: `checkout-expired:${current.openCheckoutSessionRef}`,
            type: "checkout.expired",
            subscriptionId: current.id,
            companyId: current.companyId,
            rawPayload: { sessionRef: current.openCheckoutSessionRef },
          });
          await deps.store.markLedgerApplied(ledgerId, deps.now().toISOString());
          current = { ...current, openCheckoutSessionRef: null, openCheckoutUrl: null, updatedAt: deps.now().toISOString() };
          await deps.store.updateSubscription(current);
          report.expiredCheckouts += 1;
        }
        // "complete" needs no action: phases 1–2 recover the completed event.
      }
    } catch (error) {
      warn("stuck checkout", error, { companyId: current.companyId });
    }

    try {
      await applyStandingCommand(deps.standing, current.companyId, expectedStanding(current, deps.config));
      report.standingsReconciled += 1;
    } catch (error) {
      warn("standing reconciliation", error, { companyId: current.companyId });
    }
  }

  return report;
}
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/sweep.spec.ts` — expect all passing.
- [ ] Run the full suite `pnpm --filter @paperclipai/plugin-billing test` — everything from Tasks 1–13 green.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/sweep.ts packages/plugins/plugin-billing/tests/sweep.spec.ts
git commit -m "feat(plugin-billing): reconciliation sweep for pickup, clock, standings, deletions, replay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 14: BillingService (summary, checkout, one-click, cancel/resume, portal, admin ops)

**Files:**
- Create: `packages/plugins/plugin-billing/src/format.ts` (dependency-free money formatting — lives outside `service.ts` so the UI bundle (Task 16) can import it without dragging worker-side code and `node:crypto` into the browser bundle)
- Create: `packages/plugins/plugin-billing/src/service.ts`
- Test: `packages/plugins/plugin-billing/tests/service.spec.ts`

**Interfaces:**
- Consumes: Tasks 5–12 modules.
- Produces:

```ts
export interface BillingSummary {
  companyId: string; status: SubscriptionStatus; priceCents: number; currency: string;
  trialEndsAt: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean;
  graceDeadline: string | null; hasDefaultPaymentMethod: boolean;
  openCheckoutSessionRef: string | null; openCheckoutUrl: string | null;
  events: Array<{ type: string; createdAt: string; appliedAt: string | null }>;
}
export interface CreationDisclosure { requiresSubscription: boolean; trialAvailable: boolean; trialDays: number; priceCents: number; currency: string; message: string; }
export interface AdminCompanyRow { companyId: string; status: SubscriptionStatus; ownerUserId: string; priceCents: number; priceCentsOverride: number | null; currency: string; trialEndsAt: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; hasOpenCheckout: boolean; }
export function formatAmount(cents: number, currency: string): string; // "€49.00" | "$49.00" | "49.00 CHF"
export interface ServiceDeps extends ApplyDeps { owners: OwnerResolver; }
export class BillingService {
  constructor(deps: ServiceDeps);
  summary(companyId: string): Promise<BillingSummary>;
  creationSummary(actorUserId: string): Promise<CreationDisclosure>;
  createCheckout(companyId: string): Promise<{ url: string; sessionRef: string }>;
  resolveCheckout(companyId: string, sessionRef: string): Promise<{ state: "complete" | "open" | "expired"; status: SubscriptionStatus }>;
  oneClickSubscribe(companyId: string): Promise<{ status: "active" } | { status: "requires_action"; url: string }>;
  cancelAtPeriodEnd(companyId: string): Promise<BillingSummary>;
  resume(companyId: string): Promise<BillingSummary>;
  portal(companyId: string): Promise<{ url: string | null }>;
  markSavedMethod(ownerUserId: string): Promise<void>; // called by the stub simulator action when a method is saved
  adminOverview(): Promise<AdminCompanyRow[]>;
  adminSetPriceOverride(companyId: string, priceCents: number | null): Promise<BillingSummary>;
  adminExtendTrial(companyId: string, days: number): Promise<BillingSummary>;
  adminForceResync(companyId: string): Promise<BillingSummary>;
}
```

Behavioral decisions (all spec-driven):
- Every read path calls `ensureSubscriptionForCompany` first — a missing row is repaired on sight, not just nightly (spec §8 "missing subscription row ⇒ create per matrix").
- `createCheckout` idempotency (spec §6.3): live `openCheckoutSessionRef` + provider says `"open"` ⇒ return the SAME url/ref; `"complete"` ⇒ `BillingUserError("checkout_confirming", …)`; `"expired"` ⇒ clear and mint a new session. Payer is `sub.ownerUserId` (ownership-transfer rule §6.2: billing stays with the original payer).
- `oneClickSubscribe`: no saved method ⇒ `BillingUserError("no_payment_method")`; `requires_action` passes the provider url through untouched (SCA fallback); `active` applies an optimistic `one_click.activated` ledger event (`subRef: null`) — the provider's own `payment.succeeded` webhook later attaches the real `subRef` via the companyId fallback (Task 11).
- Owner cancel/resume call the provider FIRST, then ledger+apply — if the provider is down the local flag must not silently diverge from provider renewal behavior.
- `portal`: `provider.createPortal` is optional and the stub does not implement it ⇒ `{ url: null }`, UI hides the button.
- Admin comp (override 0) rides the Task 6 effect that `cancelNow`s any live provider subscription.

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/service.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BILLING_CONFIG } from "../src/config.js";
import { BILLING_PAGE_PATH } from "../src/constants.js";
import { BillingUserError } from "../src/domain.js";
import { MemoryStubStateStore, StubProvider } from "../src/provider/stub.js";
import { handleProviderWebhook } from "../src/webhook.js";
import { BillingService, formatAmount, type ServiceDeps } from "../src/service.js";
import { MemoryBillingStore } from "../src/store-memory.js";

const SECRET = "e".repeat(64);
const NOW = new Date("2026-07-18T12:00:00.000Z");

function harness(configOverrides: Partial<typeof DEFAULT_BILLING_CONFIG> = {}) {
  const store = new MemoryBillingStore(() => NOW);
  const standingCalls: Array<Record<string, unknown>> = [];
  let now = NOW;

  const provider: StubProvider = new StubProvider({
    store: new MemoryStubStateStore(),
    secret: SECRET,
    transport: { deliver: (headers, rawBody) => handleProviderWebhook(deps, { headers, rawBody }) },
    now: () => now,
  });

  const deps: ServiceDeps = {
    store,
    config: { ...DEFAULT_BILLING_CONFIG, ...configOverrides },
    standing: {
      set: async (companyId, input) => { standingCalls.push({ kind: "set", companyId, status: input.status }); },
      clear: async (companyId) => { standingCalls.push({ kind: "clear", companyId }); },
    },
    provider,
    logger: { warn: vi.fn() },
    now: () => now,
    owners: { resolveOwnerUserId: async () => "user-1" },
  };
  const service = new BillingService(deps);
  return { service, deps, store, provider, standingCalls, setNow: (d: Date) => { now = d; } };
}

describe("formatAmount", () => {
  it("formats known symbols and falls back to code suffix", () => {
    expect(formatAmount(4900, "EUR")).toBe("€49.00");
    expect(formatAmount(9950, "USD")).toBe("$99.50");
    expect(formatAmount(4900, "CHF")).toBe("49.00 CHF");
  });
});

describe("summary", () => {
  it("creates a missing row on sight and reports trial data + ledger history", async () => {
    const { service } = harness();
    const summary = await service.summary("co-1");
    expect(summary.status).toBe("trialing");
    expect(summary.priceCents).toBe(4900);
    expect(summary.currency).toBe("EUR");
    expect(summary.trialEndsAt).toBe("2026-07-25T12:00:00.000Z");
    expect(summary.hasDefaultPaymentMethod).toBe(false);
    expect(summary.events.map((event) => event.type).sort()).toEqual(["subscription.created", "trial.started"]);
  });
});

describe("creationSummary", () => {
  it("offers the trial when the owner is still eligible", async () => {
    const { service } = harness();
    const disclosure = await service.creationSummary("user-1");
    expect(disclosure).toMatchObject({ requiresSubscription: false, trialAvailable: true, trialDays: 7, priceCents: 4900 });
    expect(disclosure.message).toBe("Your new company starts with a 7-day free trial, then €49.00/month.");
  });

  it("discloses the price once the owner's trial is burned", async () => {
    const { service } = harness();
    await service.summary("co-1"); // burns the trial via trial.started ledger row
    const disclosure = await service.creationSummary("user-1");
    expect(disclosure).toMatchObject({ requiresSubscription: true, trialAvailable: false });
    expect(disclosure.message).toBe("New companies require a €49.00/month subscription.");
  });

  it("honors trialPolicy none and every-company", async () => {
    const none = harness({ trialPolicy: "none" });
    expect((await none.service.creationSummary("user-1")).requiresSubscription).toBe(true);
    const every = harness({ trialPolicy: "every-company" });
    await every.service.summary("co-1");
    expect((await every.service.creationSummary("user-1")).trialAvailable).toBe(true);
  });
});

describe("createCheckout", () => {
  it("mints a session, persists ref+url, and reuses the open session on repeat calls", async () => {
    const { service, store } = harness({ trialPolicy: "none" });
    const first = await service.createCheckout("co-1");
    expect(first.url).toContain("billing-checkout?session=");
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.openCheckoutSessionRef).toBe(first.sessionRef);
    expect(sub.openCheckoutUrl).toBe(first.url);
    const second = await service.createCheckout("co-1");
    expect(second).toEqual(first); // never two live sessions per company
  });

  it("passes remaining trial to the provider when subscribing during a trial", async () => {
    const { service, provider } = harness();
    const spy = vi.spyOn(provider, "createCheckout");
    await service.createCheckout("co-1");
    expect(spy.mock.calls[0][0].trialEndsAt?.toISOString()).toBe("2026-07-25T12:00:00.000Z");
    expect(spy.mock.calls[0][0].successUrl).toBe(`${BILLING_PAGE_PATH}?checkout=success&session={SESSION_REF}`);
  });

  it("rejects for active and complimentary subscriptions", async () => {
    const { service, store } = harness({ trialPolicy: "none" });
    await service.summary("co-1");
    await store.updateSubscription({ ...(await store.getSubscriptionByCompany("co-1"))!, status: "active" });
    await expect(service.createCheckout("co-1")).rejects.toThrow(BillingUserError);
    await store.updateSubscription({ ...(await store.getSubscriptionByCompany("co-1"))!, status: "complimentary" });
    await expect(service.createCheckout("co-1")).rejects.toThrow(BillingUserError);
  });

  it("full checkout → webhook → active → standing cleared; resolveCheckout confirms instantly", async () => {
    const { service, provider, store } = harness({ trialPolicy: "none" });
    const { sessionRef } = await service.createCheckout("co-1");
    await provider.completeCheckout(sessionRef, { savePaymentMethod: false });
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.status).toBe("active");
    expect(sub.openCheckoutSessionRef).toBeNull();
    expect(await service.resolveCheckout("co-1", sessionRef)).toEqual({ state: "complete", status: "active" });
  });
});

describe("oneClickSubscribe", () => {
  it("requires a saved payment method", async () => {
    const { service } = harness({ trialPolicy: "none" });
    await expect(service.oneClickSubscribe("co-1")).rejects.toMatchObject({ code: "no_payment_method" });
  });

  it("activates immediately with a saved method (optimistic apply + provider webhook attaches subRef)", async () => {
    const { service, provider, store } = harness({ trialPolicy: "none" });
    // first company pays by checkout and saves the card
    const { sessionRef } = await service.createCheckout("co-1");
    await provider.completeCheckout(sessionRef, { savePaymentMethod: true });
    await service.markSavedMethod("user-1");
    // second company: one click
    const result = await service.oneClickSubscribe("co-2");
    expect(result).toEqual({ status: "active" });
    const sub = (await store.getSubscriptionByCompany("co-2"))!;
    expect(sub.status).toBe("active");
    expect(sub.providerSubscriptionId).not.toBeNull(); // stub's payment.succeeded landed via companyId fallback
  });

  it("passes the SCA requires_action url through", async () => {
    const { service, provider, store } = harness({ trialPolicy: "none" });
    const { sessionRef } = await service.createCheckout("co-1");
    await provider.completeCheckout(sessionRef, { savePaymentMethod: true });
    await service.markSavedMethod("user-1");
    const customer = (await store.getCustomerByUser("stub", "user-1"))!;
    await provider.setScaRequired(customer.providerCustomerId, true);
    const result = await service.oneClickSubscribe("co-2");
    expect(result.status).toBe("requires_action");
    if (result.status === "requires_action") expect(result.url).toContain("billing-checkout?session=");
    expect((await store.getSubscriptionByCompany("co-2"))!.status).toBe("awaiting_payment"); // unchanged until SCA completes
  });
});

describe("cancel / resume / portal", () => {
  async function activeCompany(h: ReturnType<typeof harness>) {
    const { sessionRef } = await h.service.createCheckout("co-1");
    await h.provider.completeCheckout(sessionRef, { savePaymentMethod: false });
  }

  it("cancelAtPeriodEnd flags locally and at the provider; resume undoes both", async () => {
    const h = harness({ trialPolicy: "none" });
    await activeCompany(h);
    const cancelSpy = vi.spyOn(h.provider, "cancelAtPeriodEnd");
    const resumeSpy = vi.spyOn(h.provider, "resume");
    const afterCancel = await h.service.cancelAtPeriodEnd("co-1");
    expect(afterCancel.cancelAtPeriodEnd).toBe(true);
    expect(cancelSpy).toHaveBeenCalledOnce();
    const afterResume = await h.service.resume("co-1");
    expect(afterResume.cancelAtPeriodEnd).toBe(false);
    expect(resumeSpy).toHaveBeenCalledOnce();
  });

  it("provider failure aborts the local cancel (no silent divergence)", async () => {
    const h = harness({ trialPolicy: "none" });
    await activeCompany(h);
    vi.spyOn(h.provider, "cancelAtPeriodEnd").mockRejectedValue(new Error("down"));
    await expect(h.service.cancelAtPeriodEnd("co-1")).rejects.toMatchObject({ code: "provider_unavailable" });
    expect((await h.store.getSubscriptionByCompany("co-1"))!.cancelAtPeriodEnd).toBe(false);
  });

  it("cancel/resume demand an active provider-backed subscription", async () => {
    const h = harness({ trialPolicy: "none" });
    await h.service.summary("co-1"); // awaiting_payment
    await expect(h.service.cancelAtPeriodEnd("co-1")).rejects.toMatchObject({ code: "not_active" });
    await expect(h.service.resume("co-1")).rejects.toMatchObject({ code: "not_active" });
  });

  it("portal returns null url for the stub (no hosted portal)", async () => {
    const h = harness({ trialPolicy: "none" });
    await activeCompany(h);
    expect(await h.service.portal("co-1")).toEqual({ url: null });
  });
});

describe("admin operations", () => {
  it("adminOverview lists one row per subscription with effective price", async () => {
    const { service } = harness();
    await service.summary("co-1");
    await service.summary("co-2");
    const rows = await service.adminOverview();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ownerUserId: "user-1", priceCents: 4900, currency: "EUR" });
  });

  it("price override 0 comps the company and cancels the provider subscription", async () => {
    const h = harness({ trialPolicy: "none" });
    const { sessionRef } = await h.service.createCheckout("co-1");
    await h.provider.completeCheckout(sessionRef, { savePaymentMethod: false });
    const cancelNow = vi.spyOn(h.provider, "cancelNow");
    const summary = await h.service.adminSetPriceOverride("co-1", 0);
    expect(summary.status).toBe("complimentary");
    expect(cancelNow).toHaveBeenCalledOnce();
    const back = await h.service.adminSetPriceOverride("co-1", null);
    expect(back.status).toBe("awaiting_payment");
  });

  it("rejects a negative override", async () => {
    const { service } = harness();
    await expect(service.adminSetPriceOverride("co-1", -100)).rejects.toMatchObject({ code: "invalid_price" });
  });

  it("adminExtendTrial extends from max(now, current trial end) and revives a trial-origin grace", async () => {
    const h = harness();
    await h.service.summary("co-1"); // trialing until 07-25
    const extended = await h.service.adminExtendTrial("co-1", 7);
    expect(extended.trialEndsAt).toBe("2026-08-01T12:00:00.000Z");
    await expect(h.service.adminExtendTrial("co-1", 0)).rejects.toMatchObject({ code: "invalid_days" });
  });

  it("adminForceResync reconciles standing and reports the summary", async () => {
    const h = harness();
    await h.service.summary("co-1");
    const before = h.standingCalls.length;
    const summary = await h.service.adminForceResync("co-1");
    expect(summary.status).toBe("trialing");
    expect(h.standingCalls.length).toBeGreaterThan(before);
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/service.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/format.ts`:

```ts
const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

export function formatAmount(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${amount}` : `${amount} ${currency.toUpperCase()}`;
}
```

- [ ] Create `packages/plugins/plugin-billing/src/service.ts`:

```ts
import { randomUUID } from "node:crypto";
import { applyBillingEvent, type ApplyDeps } from "./apply.js";
import { BILLING_PAGE_PATH } from "./constants.js";
import { ensureSubscriptionForCompany, type OwnerResolver } from "./creation.js";
import { BillingUserError, type SubscriptionRow, type SubscriptionStatus } from "./domain.js";
import { formatAmount } from "./format.js";
import { applyStandingCommand } from "./standing.js";
import { addDaysIso, expectedStanding } from "./state-machine.js";

export { formatAmount } from "./format.js";

export interface BillingSummary {
  companyId: string;
  status: SubscriptionStatus;
  priceCents: number;
  currency: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  graceDeadline: string | null;
  hasDefaultPaymentMethod: boolean;
  openCheckoutSessionRef: string | null;
  openCheckoutUrl: string | null;
  events: Array<{ type: string; createdAt: string; appliedAt: string | null }>;
}

export interface CreationDisclosure {
  requiresSubscription: boolean;
  trialAvailable: boolean;
  trialDays: number;
  priceCents: number;
  currency: string;
  message: string;
}

export interface AdminCompanyRow {
  companyId: string;
  status: SubscriptionStatus;
  ownerUserId: string;
  priceCents: number;
  priceCentsOverride: number | null;
  currency: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasOpenCheckout: boolean;
}

export interface ServiceDeps extends ApplyDeps {
  owners: OwnerResolver;
}

export class BillingService {
  constructor(private readonly deps: ServiceDeps) {}

  private priceCents(sub: SubscriptionRow): number {
    return sub.priceCentsOverride ?? this.deps.config.defaultMonthlyPriceCents;
  }

  private async ensure(companyId: string): Promise<SubscriptionRow> {
    return ensureSubscriptionForCompany(this.deps, companyId);
  }

  private async clearOpenCheckout(sub: SubscriptionRow): Promise<SubscriptionRow> {
    const ledgerId = randomUUID();
    await this.deps.store.insertLedgerEvent({
      id: ledgerId,
      idempotencyKey: `checkout-expired:${sub.openCheckoutSessionRef}`,
      type: "checkout.expired",
      subscriptionId: sub.id,
      companyId: sub.companyId,
      rawPayload: { sessionRef: sub.openCheckoutSessionRef },
    });
    await this.deps.store.markLedgerApplied(ledgerId, this.deps.now().toISOString());
    const cleared = { ...sub, openCheckoutSessionRef: null, openCheckoutUrl: null, updatedAt: this.deps.now().toISOString() };
    await this.deps.store.updateSubscription(cleared);
    return cleared;
  }

  async summary(companyId: string): Promise<BillingSummary> {
    const sub = await this.ensure(companyId);
    const customer = await this.deps.store.getCustomerByUser(this.deps.config.provider, sub.ownerUserId);
    const events = await this.deps.store.listLedgerEventsForCompany(companyId, 25);
    return {
      companyId,
      status: sub.status,
      priceCents: this.priceCents(sub),
      currency: this.deps.config.currency,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      graceDeadline: sub.graceSince ? addDaysIso(sub.graceSince, this.deps.config.graceDays) : null,
      hasDefaultPaymentMethod: customer?.hasDefaultPaymentMethod ?? false,
      openCheckoutSessionRef: sub.openCheckoutSessionRef,
      openCheckoutUrl: sub.openCheckoutUrl,
      events: events.map((event) => ({ type: event.type, createdAt: event.createdAt, appliedAt: event.appliedAt })),
    };
  }

  /** Price disclosure for the create-company dialog (spec §6.3): no surprises post-create. */
  async creationSummary(actorUserId: string): Promise<CreationDisclosure> {
    const config = this.deps.config;
    const price = formatAmount(config.defaultMonthlyPriceCents, config.currency);
    const trialAvailable = config.trialDays > 0
      && (config.trialPolicy === "every-company"
        || (config.trialPolicy === "first-company-per-owner" && !(await this.deps.store.ownerHadTrial(actorUserId))));
    return {
      requiresSubscription: !trialAvailable,
      trialAvailable,
      trialDays: config.trialDays,
      priceCents: config.defaultMonthlyPriceCents,
      currency: config.currency,
      message: trialAvailable
        ? `Your new company starts with a ${config.trialDays}-day free trial, then ${price}/month.`
        : `New companies require a ${price}/month subscription.`,
    };
  }

  /** Idempotent: one live checkout session per company (spec §6.3). */
  async createCheckout(companyId: string): Promise<{ url: string; sessionRef: string }> {
    let sub = await this.ensure(companyId);
    if (sub.status === "complimentary") throw new BillingUserError("complimentary", "This company is complimentary — no subscription needed.");
    if (sub.status === "active") throw new BillingUserError("already_subscribed", "This company already has an active subscription.");

    if (sub.openCheckoutSessionRef && sub.openCheckoutUrl) {
      const state = this.deps.provider.resolveCheckout
        ? await this.deps.provider.resolveCheckout(sub.openCheckoutSessionRef)
        : "open";
      if (state === "open") return { url: sub.openCheckoutUrl, sessionRef: sub.openCheckoutSessionRef };
      if (state === "complete") throw new BillingUserError("checkout_confirming", "Your payment is being confirmed — this page updates automatically.");
      sub = await this.clearOpenCheckout(sub);
    }

    let customer = await this.deps.store.getCustomerByUser(this.deps.config.provider, sub.ownerUserId);
    if (!customer) {
      const { customerId } = await this.deps.provider.ensureCustomer({
        id: sub.ownerUserId,
        // The SDK exposes no user email/name; the stub ignores them (see STRIPE_ADAPTER.md).
        email: `user-${sub.ownerUserId}@billing.invalid`,
        name: sub.ownerUserId,
      });
      customer = { id: randomUUID(), userId: sub.ownerUserId, provider: this.deps.config.provider, providerCustomerId: customerId, hasDefaultPaymentMethod: false };
      await this.deps.store.upsertCustomer(customer);
    }

    const { url, sessionRef } = await this.deps.provider.createCheckout({
      customerId: customer.providerCustomerId,
      companyId,
      priceCents: this.priceCents(sub),
      currency: this.deps.config.currency,
      trialEndsAt: sub.status === "trialing" && sub.trialEndsAt ? new Date(sub.trialEndsAt) : undefined,
      successUrl: `${BILLING_PAGE_PATH}?checkout=success&session={SESSION_REF}`,
      cancelUrl: `${BILLING_PAGE_PATH}?checkout=cancel`,
    });

    const ledgerId = randomUUID();
    await this.deps.store.insertLedgerEvent({
      id: ledgerId,
      idempotencyKey: `checkout-created:${sessionRef}`,
      type: "checkout.created",
      subscriptionId: sub.id,
      companyId,
      rawPayload: { sessionRef, url },
    });
    await this.deps.store.markLedgerApplied(ledgerId, this.deps.now().toISOString());
    await this.deps.store.updateSubscription({
      ...sub,
      customerId: customer.id,
      openCheckoutSessionRef: sessionRef,
      openCheckoutUrl: url,
      updatedAt: this.deps.now().toISOString(),
    });
    return { url, sessionRef };
  }

  /** Server-side confirmation for the "Confirming payment…" page — never trusts redirect params. */
  async resolveCheckout(companyId: string, sessionRef: string): Promise<{ state: "complete" | "open" | "expired"; status: SubscriptionStatus }> {
    let sub = await this.ensure(companyId);
    const state = this.deps.provider.resolveCheckout ? await this.deps.provider.resolveCheckout(sessionRef) : "open";
    if (state === "expired" && sub.openCheckoutSessionRef === sessionRef) {
      sub = await this.clearOpenCheckout(sub);
    }
    const fresh = await this.deps.store.getSubscriptionByCompany(companyId);
    return { state, status: (fresh ?? sub).status };
  }

  async oneClickSubscribe(companyId: string): Promise<{ status: "active" } | { status: "requires_action"; url: string }> {
    const sub = await this.ensure(companyId);
    if (sub.status === "complimentary") throw new BillingUserError("complimentary", "This company is complimentary — no subscription needed.");
    if (sub.status === "active") throw new BillingUserError("already_subscribed", "This company already has an active subscription.");

    const customer = await this.deps.store.getCustomerByUser(this.deps.config.provider, sub.ownerUserId);
    if (!customer || !customer.hasDefaultPaymentMethod) {
      throw new BillingUserError("no_payment_method", "No saved payment method on file — use checkout instead.");
    }

    const result = await this.deps.provider.subscribeWithSavedMethod({
      customerId: customer.providerCustomerId,
      companyId,
      priceCents: this.priceCents(sub),
      currency: this.deps.config.currency,
      trialEndsAt: sub.status === "trialing" && sub.trialEndsAt ? new Date(sub.trialEndsAt) : undefined,
    });
    if (result.status === "requires_action") return result;

    // Optimistic activation; the provider's payment.succeeded webhook attaches the real subRef.
    const freshest = (await this.deps.store.getSubscriptionByCompany(companyId)) ?? sub;
    if (freshest.status !== "active") {
      const periodEnd = freshest.status === "trialing" && freshest.trialEndsAt
        ? freshest.trialEndsAt
        : addDaysIso(this.deps.now().toISOString(), 30);
      const ledgerId = randomUUID();
      const inserted = await this.deps.store.insertLedgerEvent({
        id: ledgerId,
        idempotencyKey: `oneclick:${companyId}:${randomUUID()}`,
        type: "one_click.activated",
        subscriptionId: freshest.id,
        companyId,
        rawPayload: { subRef: null, periodEnd },
      });
      if (inserted === "inserted") {
        await applyBillingEvent(this.deps, freshest, { type: "one_click.activated", subRef: null, periodEnd }, ledgerId);
      }
    }
    return { status: "active" };
  }

  private async ownerAction(companyId: string, kind: "cancel" | "resume"): Promise<BillingSummary> {
    const sub = await this.ensure(companyId);
    if (sub.status !== "active" || sub.providerSubscriptionId === null) {
      throw new BillingUserError("not_active", "This company has no active provider subscription.");
    }
    try {
      if (kind === "cancel") await this.deps.provider.cancelAtPeriodEnd(sub.providerSubscriptionId);
      else await this.deps.provider.resume(sub.providerSubscriptionId);
    } catch {
      throw new BillingUserError("provider_unavailable", "The payment provider is unreachable — try again shortly.");
    }
    const type = kind === "cancel" ? "owner.cancel_at_period_end" : "owner.resume";
    const ledgerId = randomUUID();
    await this.deps.store.insertLedgerEvent({
      id: ledgerId,
      idempotencyKey: `${type}:${companyId}:${randomUUID()}`,
      type,
      subscriptionId: sub.id,
      companyId,
      rawPayload: {},
    });
    await applyBillingEvent(this.deps, sub, { type } as { type: "owner.cancel_at_period_end" | "owner.resume" }, ledgerId);
    return this.summary(companyId);
  }

  cancelAtPeriodEnd(companyId: string): Promise<BillingSummary> {
    return this.ownerAction(companyId, "cancel");
  }

  resume(companyId: string): Promise<BillingSummary> {
    return this.ownerAction(companyId, "resume");
  }

  async portal(companyId: string): Promise<{ url: string | null }> {
    const sub = await this.ensure(companyId);
    if (!this.deps.provider.createPortal) return { url: null };
    const customer = await this.deps.store.getCustomerByUser(this.deps.config.provider, sub.ownerUserId);
    if (!customer) return { url: null };
    const { url } = await this.deps.provider.createPortal(customer.providerCustomerId);
    return { url };
  }

  /** Stub-simulator hook: the plugin-side saved-method flag drives the one-click CTA. */
  async markSavedMethod(ownerUserId: string): Promise<void> {
    const customer = await this.deps.store.getCustomerByUser(this.deps.config.provider, ownerUserId);
    if (customer && !customer.hasDefaultPaymentMethod) {
      await this.deps.store.upsertCustomer({ ...customer, hasDefaultPaymentMethod: true });
    }
  }

  async adminOverview(): Promise<AdminCompanyRow[]> {
    const subs = await this.deps.store.listSubscriptions();
    return subs.map((sub) => ({
      companyId: sub.companyId,
      status: sub.status,
      ownerUserId: sub.ownerUserId,
      priceCents: this.priceCents(sub),
      priceCentsOverride: sub.priceCentsOverride,
      currency: this.deps.config.currency,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      hasOpenCheckout: sub.openCheckoutSessionRef !== null,
    }));
  }

  async adminSetPriceOverride(companyId: string, priceCents: number | null): Promise<BillingSummary> {
    if (priceCents !== null && (!Number.isInteger(priceCents) || priceCents < 0)) {
      throw new BillingUserError("invalid_price", "Price override must be a non-negative integer or null.");
    }
    const sub = await this.ensure(companyId);
    const ledgerId = randomUUID();
    await this.deps.store.insertLedgerEvent({
      id: ledgerId,
      idempotencyKey: `admin-price:${companyId}:${randomUUID()}`,
      type: "admin.set_price_override",
      subscriptionId: sub.id,
      companyId,
      rawPayload: { priceCents },
    });
    await applyBillingEvent(this.deps, sub, { type: "admin.set_price_override", priceCents }, ledgerId);
    return this.summary(companyId);
  }

  async adminExtendTrial(companyId: string, days: number): Promise<BillingSummary> {
    if (!Number.isInteger(days) || days <= 0) {
      throw new BillingUserError("invalid_days", "Trial extension must be a positive whole number of days.");
    }
    const sub = await this.ensure(companyId);
    const base = sub.trialEndsAt && Date.parse(sub.trialEndsAt) > this.deps.now().getTime()
      ? sub.trialEndsAt
      : this.deps.now().toISOString();
    const trialEndsAt = addDaysIso(base, days);
    const ledgerId = randomUUID();
    await this.deps.store.insertLedgerEvent({
      id: ledgerId,
      idempotencyKey: `admin-trial:${companyId}:${randomUUID()}`,
      type: "admin.extend_trial",
      subscriptionId: sub.id,
      companyId,
      rawPayload: { trialEndsAt },
    });
    await applyBillingEvent(this.deps, sub, { type: "admin.extend_trial", trialEndsAt }, ledgerId);
    return this.summary(companyId);
  }

  /** Re-derive standing, retry this company's unapplied ledger rows, expire stale checkout. */
  async adminForceResync(companyId: string): Promise<BillingSummary> {
    let sub = await this.ensure(companyId);
    if (sub.openCheckoutSessionRef && this.deps.provider.resolveCheckout) {
      const state = await this.deps.provider.resolveCheckout(sub.openCheckoutSessionRef);
      if (state === "expired") sub = await this.clearOpenCheckout(sub);
    }
    await applyStandingCommand(this.deps.standing, companyId, expectedStanding(sub, this.deps.config));
    return this.summary(companyId);
  }
}
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/service.spec.ts` — expect all passing.
- [ ] Run `pnpm --filter @paperclipai/plugin-billing typecheck`.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/format.ts packages/plugins/plugin-billing/src/service.ts packages/plugins/plugin-billing/tests/service.spec.ts
git commit -m "feat(plugin-billing): billing service for checkout, one-click, cancel/resume, portal, admin ops

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 15: Worker wiring (events, job, bridge handlers, webhook, api routes, authz)

**Files:**
- Create: `packages/plugins/plugin-billing/src/worker.ts`
- Test: `packages/plugins/plugin-billing/tests/worker.spec.ts`

**Interfaces:**
- Consumes: everything above; `definePlugin` / `PluginContext` / `createTestHarness`.
- Produces:

```ts
export interface WorkerOverrides {
  store?: BillingStore;
  stubStateStore?: StubStateStore;
  transport?: StubTransport;
  now?: () => Date;
  /** Test hook: receives the worker's StubProvider instance once setup builds it (used by the e2e journey to drive SCA/dunning flags). */
  onStubReady?: (stub: StubProvider) => void;
}
export function createWorker(overrides?: WorkerOverrides): PaperclipPlugin; // default export = createWorker()
```

**Authz model (code-grounded — see Global Constraints deviation 2):**
- Company-scoped bridge calls: the host injects the authorized `companyId` into action params and `context.companyId` after `assertCompanyAccess` (`server/src/routes/plugins.ts:707-783`). The worker takes the company ONLY from `context.companyId` (actions) / `params.companyId` (data) — never from caller-supplied fields.
- Admin bridge calls: a bridge call WITHOUT `companyId` passes `assertInstanceAdmin` host-side. Worker invariants:
  - admin actions require `context.companyId === null && context.actor.type === "user"`; the target company travels as `params.targetCompanyId`.
  - admin data keys reject any call where `params.companyId` is defined (a defined value proves the call came through the company-scoped path).
- `apiRoutes`: the host resolves + asserts company access before dispatch and passes a trusted `input.actor.userId` — `creation-summary` uses it for trial eligibility. Admin operations are NOT exposed as apiRoutes.
- Webhook: unauthenticated-but-signed; only `endpointKey === "provider"` is accepted; verification failure throws (host records delivery `failed`, non-2xx).

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/worker.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { MemoryBillingStore } from "../src/store-memory.js";
import { MemoryStubStateStore } from "../src/provider/stub.js";
import { createWorker } from "../src/worker.js";
import { WEBHOOK_ENDPOINT_KEY } from "../src/constants.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");

function mkCompany(id: string): Company {
  return {
    id,
    name: `Company ${id}`,
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "PC",
    issueCounter: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 0,
    defaultResponsibleUserId: "user-1",
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  } as Company;
}

async function makeWorker() {
  const store = new MemoryBillingStore(() => NOW);
  const stubStateStore = new MemoryStubStateStore();
  const standingCalls: Array<Record<string, unknown>> = [];

  const plugin = createWorker({
    store,
    stubStateStore,
    transport: {
      deliver: (headers, rawBody) =>
        plugin.definition.onWebhook!({
          endpointKey: WEBHOOK_ENDPOINT_KEY,
          headers,
          rawBody,
          parsedBody: JSON.parse(rawBody),
          requestId: "req-1",
        }),
    },
    now: () => NOW,
  });

  const harness = createTestHarness({ manifest });
  Object.assign(harness.ctx.companies, {
    setStanding: async (companyId: string, input: Record<string, unknown>) => {
      standingCalls.push({ kind: "set", companyId, ...input });
    },
    clearStanding: async (companyId: string) => {
      standingCalls.push({ kind: "clear", companyId });
    },
  });
  harness.seed({ companies: [mkCompany("co-1"), mkCompany("co-2")] });
  await plugin.definition.setup(harness.ctx);
  return { plugin, harness, store, standingCalls };
}

describe("worker wiring", () => {
  it("company.created event creates the subscription row and writes standing", async () => {
    const { harness, store, standingCalls } = await makeWorker();
    await harness.emit("company.created", { name: "Company co-1" }, { companyId: "co-1", entityId: "co-1", entityType: "company" });
    expect(await store.getSubscriptionByCompany("co-1")).toMatchObject({ status: "trialing", ownerUserId: "user-1" });
    expect(standingCalls.at(-1)).toMatchObject({ kind: "set", status: "active", reason: "trialing" });
  });

  it("billing-sweep job runs the sweep (rowless pickup for both seeded companies)", async () => {
    const { harness, store } = await makeWorker();
    await harness.runJob("billing-sweep");
    expect(await store.getSubscriptionByCompany("co-1")).not.toBeNull();
    expect(await store.getSubscriptionByCompany("co-2")).not.toBeNull();
  });

  it("billing-summary data requires the host-authorized companyId", async () => {
    const { harness } = await makeWorker();
    const summary = await harness.getData<{ status: string }>("billing-summary", { companyId: "co-1" });
    expect(summary.status).toBe("trialing");
    await expect(harness.getData("billing-summary", {})).rejects.toThrow("company scope");
  });

  it("admin-overview data rejects company-scoped calls (only the instance-admin bridge path may call it)", async () => {
    const { harness } = await makeWorker();
    await harness.runJob("billing-sweep");
    const rows = await harness.getData<Array<{ companyId: string }>>("admin-overview", {});
    expect(rows.map((row) => row.companyId).sort()).toEqual(["co-1", "co-2"]);
    await expect(harness.getData("admin-overview", { companyId: "co-1" })).rejects.toThrow("instance admin");
  });

  it("admin actions enforce the no-company instance-admin bridge contract", async () => {
    const { harness, store } = await makeWorker();
    await harness.runJob("billing-sweep");
    // company-scoped call (owner spoof attempt): context.companyId is set → rejected
    await expect(
      harness.performAction("admin-set-price-override", { targetCompanyId: "co-1", priceCents: 0 }, {
        companyId: "co-1",
        actor: { type: "user", userId: "owner-1" },
      }),
    ).rejects.toThrow("instance admin");
    // agent actor without company scope → rejected
    await expect(
      harness.performAction("admin-set-price-override", { targetCompanyId: "co-1", priceCents: 0 }, {
        companyId: null,
        actor: { type: "agent", agentId: "agent-1" },
      }),
    ).rejects.toThrow("instance admin");
    // proper admin path
    const summary = await harness.performAction<{ status: string }>(
      "admin-set-price-override",
      { targetCompanyId: "co-1", priceCents: 0 },
      { companyId: null, actor: { type: "user", userId: "admin-1" } },
    );
    expect(summary.status).toBe("complimentary");
    expect((await store.getSubscriptionByCompany("co-1"))!.status).toBe("complimentary");
  });

  it("create-checkout → stub-checkout-complete round trip activates through the real webhook path", async () => {
    const { harness, store, standingCalls } = await makeWorker();
    const checkout = await harness.performAction<{ url: string; sessionRef: string }>(
      "create-checkout",
      {},
      { companyId: "co-1", actor: { type: "user", userId: "user-1" } },
    );
    expect(checkout.url).toContain("billing-checkout?session=");
    await harness.performAction(
      "stub-checkout-complete",
      { sessionRef: checkout.sessionRef, outcome: "pay", savePaymentMethod: true },
      { companyId: "co-1", actor: { type: "user", userId: "user-1" } },
    );
    const sub = (await store.getSubscriptionByCompany("co-1"))!;
    expect(sub.status).toBe("active");
    expect(standingCalls.at(-1)).toEqual({ kind: "clear", companyId: "co-1" });
    const summary = await harness.getData<{ hasDefaultPaymentMethod: boolean }>("billing-summary", { companyId: "co-1" });
    expect(summary.hasDefaultPaymentMethod).toBe(true);
  });

  it("stub-session data refuses sessions of other companies", async () => {
    const { harness } = await makeWorker();
    const checkout = await harness.performAction<{ sessionRef: string }>(
      "create-checkout", {}, { companyId: "co-1", actor: { type: "user", userId: "user-1" } },
    );
    await expect(
      harness.getData("stub-session", { companyId: "co-2", sessionRef: checkout.sessionRef }),
    ).rejects.toThrow("forbidden");
  });

  it("onWebhook accepts only the declared endpoint key", async () => {
    const { plugin } = await makeWorker();
    await expect(
      plugin.definition.onWebhook!({ endpointKey: "other", headers: {}, rawBody: "{}", requestId: "r" }),
    ).rejects.toThrow("unknown webhook endpoint");
  });

  it("onApiRequest serves creation-summary from the trusted actor and maps BillingUserError to 4xx", async () => {
    const { plugin, harness } = await makeWorker();
    void harness;
    const base = {
      method: "GET", path: "/creation-summary", params: {}, query: {}, body: null,
      actor: { actorType: "user" as const, actorId: "user-1", userId: "user-1", agentId: null, runId: null },
      companyId: "co-1", headers: {},
    };
    const ok = await plugin.definition.onApiRequest!({ ...base, routeKey: "creation-summary" });
    expect(ok.status).toBe(200);
    expect((ok.body as { trialAvailable: boolean }).trialAvailable).toBe(true);

    // summary then force an error path: cancel without an active subscription → 400 with typed code
    const err = await plugin.definition.onApiRequest!({
      ...base, routeKey: "cancel", method: "POST", path: "/cancel", body: { companyId: "co-1" },
    });
    expect(err.status).toBe(400);
    expect((err.body as { error: string }).error).toBe("not_active");

    const unknown = await plugin.definition.onApiRequest!({ ...base, routeKey: "nope" });
    expect(unknown.status).toBe(404);
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/worker.spec.ts` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/worker.ts`:

```ts
import { definePlugin, type PaperclipPlugin, type PluginApiRequestInput, type PluginApiResponse, type PluginContext, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { PROVIDER_STUB, SWEEP_JOB_KEY, WEBHOOK_ENDPOINT_KEY } from "./constants.js";
import { parseBillingConfig, type BillingConfig } from "./config.js";
import { ensureSubscriptionForCompany, ownerResolverFromContext, type OwnerResolver } from "./creation.js";
import { BillingUserError } from "./domain.js";
import { ensureStubWebhookSecret } from "./hmac.js";
import { HttpStubTransport, MemoryStubStateStore, SqlStubStateStore, StubProvider, type StubStateStore, type StubTransport } from "./provider/stub.js";
import { BillingService, type ServiceDeps } from "./service.js";
import { standingWriterFromContext } from "./standing.js";
import { SqlBillingStore } from "./store-sql.js";
import type { BillingStore } from "./store.js";
import { runBillingSweep, type SweepDeps } from "./sweep.js";
import { handleProviderWebhook } from "./webhook.js";

export interface WorkerOverrides {
  store?: BillingStore;
  stubStateStore?: StubStateStore;
  transport?: StubTransport;
  now?: () => Date;
  /** Test hook: receives the worker's StubProvider once setup builds it. */
  onStubReady?: (stub: StubProvider) => void;
}

interface RuntimeBase {
  store: BillingStore;
  stub: StubProvider;
  owners: OwnerResolver;
  now: () => Date;
}

// ---------------------------------------------------------------- authz

function requireCompanyFromData(params: Record<string, unknown>): string {
  const companyId = params.companyId;
  if (typeof companyId !== "string" || companyId.length === 0) {
    throw new BillingUserError("company_scope_required", "This data key requires a host-authorized company scope.");
  }
  return companyId;
}

function requireCompanyFromAction(context: PluginPerformActionContext): string {
  if (typeof context.companyId !== "string" || context.companyId.length === 0) {
    throw new BillingUserError("company_scope_required", "This action requires a host-authorized company scope.");
  }
  return context.companyId;
}

/**
 * Bridge calls without a companyId pass assertInstanceAdmin host-side
 * (server/src/routes/plugins.ts assertPluginBridgeScope). A defined
 * context.companyId proves the caller came through the company path instead.
 */
function requireAdminAction(context: PluginPerformActionContext): void {
  if (context.companyId !== null || context.actor.type !== "user") {
    throw new BillingUserError("instance_admin_required", "Only the instance admin bridge path may perform this action.");
  }
}

function requireAdminData(params: Record<string, unknown>): void {
  if (params.companyId !== undefined) {
    throw new BillingUserError("instance_admin_required", "Only the instance admin bridge path may read this data.");
  }
}

function requireTargetCompany(params: Record<string, unknown>): string {
  const target = params.targetCompanyId;
  if (typeof target !== "string" || target.length === 0) {
    throw new BillingUserError("invalid_target", "targetCompanyId is required.");
  }
  return target;
}

function toApiResponse(error: unknown): PluginApiResponse {
  if (error instanceof BillingUserError) {
    const status = error.code === "already_subscribed" || error.code === "checkout_confirming" ? 409 : 400;
    return { status, body: { error: error.code, message: error.message } };
  }
  throw error;
}

// ---------------------------------------------------------------- worker

export function createWorker(overrides: WorkerOverrides = {}): PaperclipPlugin {
  let base: RuntimeBase | null = null;

  const plugin = definePlugin({
    async setup(ctx: PluginContext) {
      const now = overrides.now ?? (() => new Date());
      const store = overrides.store ?? new SqlBillingStore(ctx.db);
      const stubStateStore = overrides.stubStateStore ?? new SqlStubStateStore(ctx.db);
      const secret = await ensureStubWebhookSecret(ctx.state);
      const transport = overrides.transport
        ?? new HttpStubTransport(async () => (await loadConfig(ctx)).instanceBaseUrl);
      const stub = new StubProvider({ store: stubStateStore, secret, transport, now });
      base = { store, stub, owners: ownerResolverFromContext(ctx), now };
      overrides.onStubReady?.(stub);

      async function loadConfig(context: PluginContext): Promise<BillingConfig> {
        try {
          return parseBillingConfig(await context.config.get());
        } catch {
          return parseBillingConfig(undefined);
        }
      }

      async function serviceDeps(): Promise<ServiceDeps> {
        const runtime = base!;
        return {
          store: runtime.store,
          config: await loadConfig(ctx),
          standing: standingWriterFromContext(ctx),
          provider: runtime.stub, // config.provider is "stub" in v1; a future adapter switches here
          logger: ctx.logger,
          now: runtime.now,
          owners: runtime.owners,
        };
      }

      async function sweepDeps(): Promise<SweepDeps> {
        const deps = await serviceDeps();
        return {
          ...deps,
          companies: {
            list: async () => (await ctx.companies.list({ limit: 500 })).map((company) => ({
              id: company.id,
              status: String(company.status),
            })),
          },
          stub: deps.config.provider === PROVIDER_STUB ? base!.stub : undefined,
        };
      }

      // ---- company lifecycle: company.created exists in the catalog; company.deleted
      // ---- does NOT (sweep-only detection — Global Constraints deviation 4).
      ctx.events.on("company.created", async (event) => {
        const companyId = event.companyId;
        if (!companyId) return;
        await ensureSubscriptionForCompany(await sweepDeps(), companyId);
      });

      ctx.jobs.register(SWEEP_JOB_KEY, async () => {
        const report = await runBillingSweep(await sweepDeps());
        ctx.logger.info("billing sweep finished", { ...report });
      });

      // ---- data (UI bridge reads)
      ctx.data.register("billing-summary", async (params) => {
        const companyId = requireCompanyFromData(params);
        return new BillingService(await serviceDeps()).summary(companyId);
      });

      ctx.data.register("stub-session", async (params) => {
        const companyId = requireCompanyFromData(params);
        const sessionRef = String(params.sessionRef ?? "");
        const session = await base!.stub.getSession(sessionRef);
        if (!session || session.companyId !== companyId) {
          throw new BillingUserError("forbidden", "forbidden: session does not belong to this company");
        }
        return session;
      });

      ctx.data.register("admin-overview", async (params) => {
        requireAdminData(params);
        return new BillingService(await serviceDeps()).adminOverview();
      });

      // ---- actions (UI bridge mutations)
      ctx.actions.register("create-checkout", async (_params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).createCheckout(companyId);
      });

      ctx.actions.register("resolve-checkout", async (params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).resolveCheckout(companyId, String(params.sessionRef ?? ""));
      });

      ctx.actions.register("one-click-subscribe", async (_params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).oneClickSubscribe(companyId);
      });

      ctx.actions.register("cancel-at-period-end", async (_params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).cancelAtPeriodEnd(companyId);
      });

      ctx.actions.register("resume-subscription", async (_params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).resume(companyId);
      });

      ctx.actions.register("open-portal", async (_params, context) => {
        const companyId = requireCompanyFromAction(context);
        return new BillingService(await serviceDeps()).portal(companyId);
      });

      ctx.actions.register("stub-checkout-complete", async (params, context) => {
        const companyId = requireCompanyFromAction(context);
        const sessionRef = String(params.sessionRef ?? "");
        const session = await base!.stub.getSession(sessionRef);
        if (!session || session.companyId !== companyId) {
          throw new BillingUserError("forbidden", "forbidden: session does not belong to this company");
        }
        const outcome = String(params.outcome ?? "pay");
        if (outcome === "fail") {
          await base!.stub.failCheckout(sessionRef);
        } else if (outcome === "cancel") {
          await base!.stub.cancelCheckout(sessionRef);
        } else {
          const savePaymentMethod = params.savePaymentMethod === true;
          await base!.stub.completeCheckout(sessionRef, { savePaymentMethod });
          if (savePaymentMethod) {
            const deps = await serviceDeps();
            const sub = await deps.store.getSubscriptionByCompany(companyId);
            if (sub) await new BillingService(deps).markSavedMethod(sub.ownerUserId);
          }
        }
        return { ok: true, session: await base!.stub.getSession(sessionRef) };
      });

      // ---- admin actions (instance-admin bridge path only)
      ctx.actions.register("admin-set-price-override", async (params, context) => {
        requireAdminAction(context);
        const target = requireTargetCompany(params);
        const priceCents = params.priceCents === null || params.priceCents === undefined ? null : Number(params.priceCents);
        return new BillingService(await serviceDeps()).adminSetPriceOverride(target, priceCents);
      });

      ctx.actions.register("admin-extend-trial", async (params, context) => {
        requireAdminAction(context);
        const target = requireTargetCompany(params);
        return new BillingService(await serviceDeps()).adminExtendTrial(target, Number(params.days));
      });

      ctx.actions.register("admin-force-resync", async (params, context) => {
        requireAdminAction(context);
        const target = requireTargetCompany(params);
        return new BillingService(await serviceDeps()).adminForceResync(target);
      });

      // stash for onWebhook/onApiRequest closures
      workerState = { ctx, serviceDeps, sweepDeps };
    },

    async onWebhook(input) {
      if (!workerState) throw new Error("billing worker not initialized");
      if (input.endpointKey !== WEBHOOK_ENDPOINT_KEY) {
        throw new Error(`unknown webhook endpoint: ${input.endpointKey}`);
      }
      await handleProviderWebhook(await workerState.serviceDeps(), {
        headers: input.headers,
        rawBody: input.rawBody,
      });
    },

    async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
      if (!workerState) return { status: 503, body: { error: "not_initialized" } };
      const service = new BillingService(await workerState.serviceDeps());
      try {
        switch (input.routeKey) {
          case "creation-summary": {
            const userId = input.actor.userId;
            if (!userId) return { status: 403, body: { error: "board_user_required" } };
            return { status: 200, body: await service.creationSummary(userId) };
          }
          case "summary":
            return { status: 200, body: await service.summary(input.companyId) };
          case "create-checkout":
            return { status: 200, body: await service.createCheckout(input.companyId) };
          case "resolve-checkout": {
            const sessionRef = String((input.body as Record<string, unknown> | null)?.sessionRef ?? "");
            return { status: 200, body: await service.resolveCheckout(input.companyId, sessionRef) };
          }
          case "one-click":
            return { status: 200, body: await service.oneClickSubscribe(input.companyId) };
          case "cancel":
            return { status: 200, body: await service.cancelAtPeriodEnd(input.companyId) };
          case "resume":
            return { status: 200, body: await service.resume(input.companyId) };
          case "portal":
            return { status: 200, body: await service.portal(input.companyId) };
          default:
            return { status: 404, body: { error: `unknown billing route: ${input.routeKey}` } };
        }
      } catch (error) {
        return toApiResponse(error);
      }
    },

    async onHealth() {
      return { status: "ok", message: "billing worker running" };
    },
  });

  let workerState: {
    ctx: PluginContext;
    serviceDeps: () => Promise<ServiceDeps>;
    sweepDeps: () => Promise<SweepDeps>;
  } | null = null;

  return plugin;
}

export default createWorker();
```

  Implementation note: `let workerState` must be declared BEFORE `definePlugin` in the final file (hoist it above `const plugin = definePlugin({...})`) — shown after here only for readability. `base` is assigned in `setup` and read by handlers registered in the same call.
- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/worker.spec.ts` — expect all passing.
- [ ] Run `pnpm --filter @paperclipai/plugin-billing typecheck` and the full suite `pnpm --filter @paperclipai/plugin-billing test`.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/worker.ts packages/plugins/plugin-billing/tests/worker.spec.ts
git commit -m "feat(plugin-billing): worker wiring with bridge authz, webhook endpoint, api routes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 16: Plugin UI — Billing page, admin page, stub checkout simulator

**Files:**
- Create: `packages/plugins/plugin-billing/src/ui/BillingPage.tsx`
- Create: `packages/plugins/plugin-billing/src/ui/AdminPage.tsx`
- Create: `packages/plugins/plugin-billing/src/ui/StubCheckoutPage.tsx`
- Create: `packages/plugins/plugin-billing/src/ui/index.tsx`
- Test: `packages/plugins/plugin-billing/tests/ui.spec.tsx`

**Interfaces:**
- Consumes: `@paperclipai/plugin-sdk/ui` — `usePluginData`, `usePluginAction`, `useHostLocation`, `useHostNavigation`, `Spinner`, `StatusBadge`, `KeyValueList`, `DataTable`; slot prop types `PluginCompanySettingsPageProps`, `PluginSettingsPageProps`, `PluginPageProps`. All host communication goes through the bridge (plugin UI must not call `fetch` directly — PLUGIN_SPEC §19.0.2).
- Produces: named exports `BillingPage`, `BillingAdminPage`, `StubCheckoutPage` matching the manifest `ui.slots[].exportName` (Task 2).
- Test approach: exactly the `plugin-llm-wiki/tests/plugin.spec.ts` pattern — stub `globalThis.__paperclipPluginBridge__.sdkUi` hooks and assert `renderToStaticMarkup` output per state (interaction flows are covered by Task 15 worker tests and Task 18 e2e).

Steps:

- [ ] Write the failing test `packages/plugins/plugin-billing/tests/ui.spec.tsx`:

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BillingSummary } from "../src/service.js";

type TestBridgeGlobal = typeof globalThis & {
  __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> };
};

let mockSummary: BillingSummary;
let mockAdminRows: Array<Record<string, unknown>> = [];
let mockSession: Record<string, unknown> | null = null;
let mockLocation = { pathname: "/pc/company/settings/billing", search: "", hash: "" };

function baseSummary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    companyId: "co-1", status: "trialing", priceCents: 4900, currency: "EUR",
    trialEndsAt: "2026-07-25T12:00:00.000Z", currentPeriodEnd: null, cancelAtPeriodEnd: false,
    graceDeadline: null, hasDefaultPaymentMethod: false,
    openCheckoutSessionRef: null, openCheckoutUrl: null,
    events: [{ type: "trial.started", createdAt: "2026-07-18T12:00:00.000Z", appliedAt: "2026-07-18T12:00:00.000Z" }],
    ...overrides,
  };
}

beforeEach(() => {
  mockSummary = baseSummary();
  mockAdminRows = [];
  mockSession = null;
  mockLocation = { pathname: "/pc/company/settings/billing", search: "", hash: "" };
  (globalThis as TestBridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginData: (key: string) => {
        if (key === "billing-summary") return { data: mockSummary, loading: false, error: null };
        if (key === "admin-overview") return { data: mockAdminRows, loading: false, error: null };
        if (key === "stub-session") return { data: mockSession, loading: false, error: null };
        return { data: null, loading: false, error: null };
      },
      usePluginAction: () => async () => ({}),
      useHostContext: () => ({ companyId: "co-1", companyPrefix: "pc" }),
      useHostNavigation: () => ({
        resolveHref: (to: string) => `/pc/${to}`,
        navigate: () => {},
        linkProps: (to: string) => ({ href: `/pc/${to}`, onClick: () => {} }),
      }),
      useHostLocation: () => mockLocation,
      usePluginToast: () => () => {},
    },
  };
});

afterEach(() => {
  delete (globalThis as TestBridgeGlobal).__paperclipPluginBridge__;
});

async function importUi() {
  return import("../src/ui/index.js");
}

describe("BillingPage states", () => {
  const context = { companyId: "co-1", companyPrefix: "pc" };

  it("trialing: countdown + subscribe CTA + price", async () => {
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Free trial");
    expect(html).toContain("2026-07-25");
    expect(html).toContain("€49.00");
    expect(html).toContain("Subscribe now");
  });

  it("awaiting_payment without card: primary subscribe CTA", async () => {
    mockSummary = baseSummary({ status: "awaiting_payment", trialEndsAt: null });
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("needs a subscription");
    expect(html).toContain("Subscribe now");
  });

  it("awaiting_payment with card on file: one-click confirm CTA", async () => {
    mockSummary = baseSummary({ status: "awaiting_payment", trialEndsAt: null, hasDefaultPaymentMethod: true });
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Add subscription for €49.00/month — uses card on file");
  });

  it("active: period end + cancel CTA; canceling shows ends-on badge and resume", async () => {
    mockSummary = baseSummary({ status: "active", currentPeriodEnd: "2026-08-18T12:00:00.000Z", trialEndsAt: null });
    const { BillingPage } = await importUi();
    let html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Renews on 2026-08-18");
    expect(html).toContain("Cancel at period end");
    mockSummary = baseSummary({ status: "active", currentPeriodEnd: "2026-08-18T12:00:00.000Z", cancelAtPeriodEnd: true, trialEndsAt: null });
    html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Ends on 2026-08-18");
    expect(html).toContain("Resume subscription");
  });

  it("grace: warning with deadline; blocked and canceled: resubscribe CTA", async () => {
    mockSummary = baseSummary({ status: "grace", graceDeadline: "2026-08-01T12:00:00.000Z", trialEndsAt: null });
    const { BillingPage } = await importUi();
    let html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("2026-08-01");
    mockSummary = baseSummary({ status: "blocked", trialEndsAt: null });
    html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("paused");
    expect(html).toContain("Subscribe now");
    mockSummary = baseSummary({ status: "canceled", trialEndsAt: null });
    html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Resubscribe");
  });

  it("complimentary: no CTA, complimentary badge", async () => {
    mockSummary = baseSummary({ status: "complimentary", trialEndsAt: null });
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Complimentary");
    expect(html).not.toContain("Subscribe now");
  });

  it("confirming-payment mode from success-return query params", async () => {
    mockLocation = { pathname: "/pc/company/settings/billing", search: "?checkout=success&session=stub_sess_1", hash: "" };
    mockSummary = baseSummary({ status: "awaiting_payment", trialEndsAt: null });
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("Confirming payment");
  });

  it("renders the ledger history", async () => {
    const { BillingPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingPage, { context } as never));
    expect(html).toContain("trial.started");
  });
});

describe("BillingAdminPage", () => {
  it("renders one row per company with status, price, trial and period ends", async () => {
    mockAdminRows = [
      { companyId: "co-1", status: "trialing", ownerUserId: "user-1", priceCents: 4900, priceCentsOverride: null, currency: "EUR", trialEndsAt: "2026-07-25T12:00:00.000Z", currentPeriodEnd: null, cancelAtPeriodEnd: false, hasOpenCheckout: false },
      { companyId: "co-2", status: "complimentary", ownerUserId: "user-2", priceCents: 0, priceCentsOverride: 0, currency: "EUR", trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, hasOpenCheckout: false },
    ];
    const { BillingAdminPage } = await importUi();
    const html = renderToStaticMarkup(createElement(BillingAdminPage, { context: {} } as never));
    expect(html).toContain("co-1");
    expect(html).toContain("trialing");
    expect(html).toContain("co-2");
    expect(html).toContain("complimentary");
    expect(html).toContain("Extend trial");
    expect(html).toContain("Force re-sync");
  });
});

describe("StubCheckoutPage", () => {
  it("renders pay / fail / cancel and the save-method toggle for an open session", async () => {
    mockLocation = { pathname: "/pc/billing-checkout", search: "?session=stub_sess_1", hash: "" };
    mockSession = {
      sessionRef: "stub_sess_1", kind: "checkout", companyId: "co-1", priceCents: 4900, currency: "EUR",
      trialEndsAtIso: null, successUrl: "company/settings/billing?checkout=success&session=stub_sess_1",
      cancelUrl: "company/settings/billing?checkout=cancel", status: "open", lastError: null,
      createdAtIso: "2026-07-18T12:00:00.000Z", customerId: "stub_cus_1",
    };
    const { StubCheckoutPage } = await importUi();
    const html = renderToStaticMarkup(createElement(StubCheckoutPage, { context: { companyId: "co-1" } } as never));
    expect(html).toContain("€49.00");
    expect(html).toContain("Pay");
    expect(html).toContain("Simulate failed payment");
    expect(html).toContain("Cancel");
    expect(html).toContain("Save payment method");
    expect(html).toContain("This is the stub payment simulator");
  });

  it("shows the decline banner after a simulated failure", async () => {
    mockLocation = { pathname: "/pc/billing-checkout", search: "?session=stub_sess_1", hash: "" };
    mockSession = {
      sessionRef: "stub_sess_1", kind: "checkout", companyId: "co-1", priceCents: 4900, currency: "EUR",
      trialEndsAtIso: null, successUrl: "s", cancelUrl: "c", status: "open", lastError: "card_declined",
      createdAtIso: "2026-07-18T12:00:00.000Z", customerId: "stub_cus_1",
    };
    const { StubCheckoutPage } = await importUi();
    const html = renderToStaticMarkup(createElement(StubCheckoutPage, { context: { companyId: "co-1" } } as never));
    expect(html).toContain("card was declined");
  });
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/ui.spec.tsx` — expect module-not-found failure.
- [ ] Create `packages/plugins/plugin-billing/src/ui/BillingPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import {
  Spinner,
  StatusBadge,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginCompanySettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { formatAmount } from "../format.js";
import type { BillingSummary } from "../service.js";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export function BillingPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId ?? "";
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const search = new URLSearchParams(location.search);
  const returnedSession = search.get("checkout") === "success" ? search.get("session") : null;

  const [tick, setTick] = useState(0);
  const [confirming, setConfirming] = useState(returnedSession !== null);
  const [confirmSlow, setConfirmSlow] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: summary, loading } = usePluginData<BillingSummary>("billing-summary", { companyId, tick });
  const createCheckout = usePluginAction("create-checkout");
  const resolveCheckout = usePluginAction("resolve-checkout");
  const oneClick = usePluginAction("one-click-subscribe");
  const cancel = usePluginAction("cancel-at-period-end");
  const resume = usePluginAction("resume-subscription");

  // Confirming payment…: server-side resolveCheckout first (sub-second), then
  // brief polling; after ~20s fall back to "taking longer than expected" —
  // the webhook + sweep reconcile and this page re-polls (spec §6.3).
  useEffect(() => {
    if (!confirming || !returnedSession) return;
    let cancelled = false;
    void resolveCheckout({ companyId, sessionRef: returnedSession }).catch(() => {});
    const interval = setInterval(() => {
      if (!cancelled) setTick((value) => value + 1);
    }, 2000);
    const slowTimer = setTimeout(() => {
      if (!cancelled) setConfirmSlow(true);
    }, 20000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(slowTimer);
    };
  }, [confirming, returnedSession, companyId, resolveCheckout]);

  useEffect(() => {
    if (confirming && summary && (summary.status === "active" || summary.status === "complimentary")) {
      setConfirming(false);
    }
  }, [confirming, summary]);

  if (loading && !summary) return <Spinner />;
  if (!summary) return <p>Billing information is unavailable.</p>;

  const price = `${formatAmount(summary.priceCents, summary.currency)}/month`;

  async function run(action: () => Promise<unknown>): Promise<void> {
    setActionError(null);
    try {
      await action();
      setTick((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function startCheckout(): Promise<void> {
    await run(async () => {
      const result = (await createCheckout({ companyId })) as { url: string };
      if (/^https?:\/\//.test(result.url)) window.location.assign(result.url);
      else navigation.navigate(result.url);
    });
  }

  async function startOneClick(): Promise<void> {
    await run(async () => {
      const result = (await oneClick({ companyId })) as { status: string; url?: string };
      if (result.status === "requires_action" && result.url) {
        if (/^https?:\/\//.test(result.url)) window.location.assign(result.url);
        else navigation.navigate(result.url);
      }
    });
  }

  const subscribeCta = summary.hasDefaultPaymentMethod ? (
    <div>
      <button onClick={() => void startOneClick()}>
        Add subscription for {formatAmount(summary.priceCents, summary.currency)}/month — uses card on file
      </button>
      <button onClick={() => void startCheckout()}>Use a different payment method</button>
    </div>
  ) : (
    <button onClick={() => void startCheckout()}>Subscribe now — {price}</button>
  );

  return (
    <div>
      <h2>Billing</h2>

      {confirming && (
        <div role="status">
          <Spinner />
          <p>Confirming payment…</p>
          {confirmSlow && <p>This is taking longer than expected — we&apos;ll update this page automatically.</p>}
        </div>
      )}

      {actionError && <p role="alert">{actionError}</p>}

      <section>
        <StatusBadge label={summary.status} status={summary.status === "active" || summary.status === "complimentary" ? "ok" : summary.status === "grace" || summary.status === "trialing" ? "warning" : "error"} />
        <dl>
          <dt>Price</dt>
          <dd>{summary.status === "complimentary" ? "Complimentary" : price}</dd>
          {summary.status === "trialing" && (
            <>
              <dt>Free trial</dt>
              <dd>Free trial — ends {day(summary.trialEndsAt)}</dd>
            </>
          )}
          {summary.currentPeriodEnd && summary.status === "active" && (
            <>
              <dt>{summary.cancelAtPeriodEnd ? "Ends" : "Renews"}</dt>
              <dd>{summary.cancelAtPeriodEnd ? `Ends on ${day(summary.currentPeriodEnd)}` : `Renews on ${day(summary.currentPeriodEnd)}`}</dd>
            </>
          )}
          {summary.status === "grace" && (
            <>
              <dt>Grace period</dt>
              <dd>Payment issue — resolve by {day(summary.graceDeadline)} to keep agents running.</dd>
            </>
          )}
        </dl>
      </section>

      <section>
        {summary.status === "trialing" && subscribeCta}
        {summary.status === "awaiting_payment" && (
          <div>
            <p>This company needs a subscription before agents can run.</p>
            {subscribeCta}
          </div>
        )}
        {summary.status === "grace" && subscribeCta}
        {summary.status === "blocked" && (
          <div>
            <p>Agent runs are paused until this company has an active subscription.</p>
            {subscribeCta}
          </div>
        )}
        {summary.status === "canceled" && (
          <button onClick={() => void startCheckout()}>Resubscribe — {price}</button>
        )}
        {summary.status === "active" && !summary.cancelAtPeriodEnd && (
          <button onClick={() => void run(() => cancel({ companyId }))}>Cancel at period end</button>
        )}
        {summary.status === "active" && summary.cancelAtPeriodEnd && (
          <button onClick={() => void run(() => resume({ companyId }))}>Resume subscription</button>
        )}
      </section>

      <section>
        <h3>History</h3>
        <ul>
          {summary.events.map((event, index) => (
            <li key={`${event.type}-${index}`}>
              <code>{event.type}</code> — {event.createdAt.slice(0, 19).replace("T", " ")}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] Create `packages/plugins/plugin-billing/src/ui/AdminPage.tsx`:

```tsx
import { useState } from "react";
import {
  Spinner,
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { formatAmount } from "../format.js";
import type { AdminCompanyRow } from "../service.js";

export function BillingAdminPage(_props: PluginSettingsPageProps) {
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  // NOTE: no companyId in the data params — the bridge call without a company
  // scope is what makes the host assert instance admin.
  const { data: rows, loading } = usePluginData<AdminCompanyRow[]>("admin-overview", { tick });
  const setPrice = usePluginAction("admin-set-price-override");
  const extendTrial = usePluginAction("admin-extend-trial");
  const resync = usePluginAction("admin-force-resync");

  if (loading && !rows) return <Spinner />;

  async function run(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await action();
      setTick((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <h2>Billing — all companies</h2>
      <p>Instance configuration (currency, default price, trial and grace policy) lives in the auto-generated config form for this plugin.</p>
      {error && <p role="alert">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Company</th><th>Status</th><th>Payer</th><th>Price</th><th>Trial ends</th><th>Period end</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((row) => (
            <tr key={row.companyId}>
              <td><code>{row.companyId}</code></td>
              <td>{row.status}{row.cancelAtPeriodEnd ? " (ends at period end)" : ""}</td>
              <td>{row.ownerUserId}</td>
              <td>
                {row.status === "complimentary" ? "Complimentary" : `${formatAmount(row.priceCents, row.currency)}/mo`}
                <input
                  aria-label={`Price override for ${row.companyId} (cents; 0 = complimentary; empty = default)`}
                  value={overrideDrafts[row.companyId] ?? (row.priceCentsOverride === null ? "" : String(row.priceCentsOverride))}
                  onChange={(event) => setOverrideDrafts((drafts) => ({ ...drafts, [row.companyId]: event.target.value }))}
                />
                <button
                  onClick={() => void run(() => {
                    const draft = (overrideDrafts[row.companyId] ?? "").trim();
                    return setPrice({ targetCompanyId: row.companyId, priceCents: draft === "" ? null : Number(draft) });
                  })}
                >
                  Set price
                </button>
              </td>
              <td>{row.trialEndsAt ? row.trialEndsAt.slice(0, 10) : "—"}</td>
              <td>{row.currentPeriodEnd ? row.currentPeriodEnd.slice(0, 10) : "—"}</td>
              <td>
                <button onClick={() => void run(() => extendTrial({ targetCompanyId: row.companyId, days: 7 }))}>Extend trial +7d</button>
                <button onClick={() => void run(() => resync({ targetCompanyId: row.companyId }))}>Force re-sync</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] Create `packages/plugins/plugin-billing/src/ui/StubCheckoutPage.tsx`:

```tsx
import { useState } from "react";
import {
  Spinner,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { formatAmount } from "../format.js";
import type { StubSession } from "../provider/stub.js";

export function StubCheckoutPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const sessionRef = new URLSearchParams(location.search).get("session") ?? "";

  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [savePaymentMethod, setSavePaymentMethod] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: session, loading } = usePluginData<StubSession | null>("stub-session", { companyId, sessionRef, tick });
  const act = usePluginAction("stub-checkout-complete");

  if (!sessionRef) return <p>Missing checkout session reference.</p>;
  if (loading && !session) return <Spinner />;
  if (!session) return <p>This checkout session does not exist.</p>;

  async function submit(outcome: "pay" | "fail" | "cancel"): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await act({ companyId, sessionRef, outcome, savePaymentMethod });
      if (outcome === "pay" && session!.successUrl) navigation.navigate(session!.successUrl);
      else if (outcome === "cancel" && session!.cancelUrl) navigation.navigate(session!.cancelUrl);
      else setTick((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Checkout</h2>
      <p>This is the stub payment simulator — no real money moves. It exercises the exact production path: signed webhook → ledger → transition → standing.</p>
      <dl>
        <dt>Amount</dt>
        <dd>{formatAmount(session.priceCents, session.currency)}/month</dd>
        {session.trialEndsAtIso && (
          <>
            <dt>Trial</dt>
            <dd>Billing starts {session.trialEndsAtIso.slice(0, 10)} (remaining trial preserved)</dd>
          </>
        )}
      </dl>

      {session.status !== "open" && <p>This session is {session.status}.</p>}
      {session.lastError === "card_declined" && <p role="alert">The card was declined. Try again or cancel.</p>}
      {error && <p role="alert">{error}</p>}

      {session.status === "open" && (
        <div>
          <label>
            <input
              type="checkbox"
              checked={savePaymentMethod}
              onChange={(event) => setSavePaymentMethod(event.target.checked)}
            />
            Save payment method for one-click subscriptions
          </label>
          <div>
            <button disabled={busy} onClick={() => void submit("pay")}>Pay {formatAmount(session.priceCents, session.currency)}</button>
            <button disabled={busy} onClick={() => void submit("fail")}>Simulate failed payment</button>
            <button disabled={busy} onClick={() => void submit("cancel")}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] Create `packages/plugins/plugin-billing/src/ui/index.tsx`:

```tsx
export { BillingPage } from "./BillingPage.js";
export { BillingAdminPage } from "./AdminPage.js";
export { StubCheckoutPage } from "./StubCheckoutPage.js";
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/ui.spec.tsx` — expect all passing. If a bridge hook name in the stub does not match what `@paperclipai/plugin-sdk/ui` reads from `__paperclipPluginBridge__.sdkUi`, copy the exact stub key set from `packages/plugins/plugin-llm-wiki/tests/plugin.spec.ts` (it is the working reference for this mechanism).
- [ ] Run `pnpm --filter @paperclipai/plugin-billing build` — worker, manifest, and UI bundles compile (esbuild).
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/src/ui packages/plugins/plugin-billing/tests/ui.spec.tsx
git commit -m "feat(plugin-billing): billing page, instance admin page, stub checkout simulator UI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 17: Create-company price disclosure (core UI integration)

**Files:**
- Create: `ui/src/api/billingDisclosure.ts`
- Modify: `ui/src/components/NewCompanyDialog.tsx` (the create-company dialog, opened from `ui/src/components/CompanySwitcher.tsx:120`)
- Test: extend `ui/src/components/NewCompanyDialog.test.tsx`

**Interfaces:**
- Consumes: billing plugin apiRoute `GET /api/plugins/paperclip-plugin-billing/api/creation-summary?companyId=<activeCompanyId>` (Task 2/15; board-auth, `companyResolution` from query — the caller passes their CURRENT company for the host's access check; trial eligibility comes from the trusted `actor.userId` server-side). `api.get` from `ui/src/api/client.ts` (BASE `/api`); `useOptionalCompany()` from `ui/src/context/CompanyContext.tsx` for `selectedCompanyId`.
- Produces: a disclosure line inside the dialog ("Your new company starts with a 7-day free trial, then €49.00/month." / "New companies require a €49.00/month subscription."). Fails silent: plugin missing/disabled/any error ⇒ no line, dialog unchanged (core must not depend on the plugin).

Steps:

- [ ] Add the failing tests to `ui/src/components/NewCompanyDialog.test.tsx` (append inside the existing `describe("NewCompanyDialog")`, reusing its `renderDialog`/`flushReact` helpers; add the module mock next to the existing `cloudCompaniesApi` mock at the top of the file):

```tsx
const mockBillingDisclosure = vi.hoisted(() => ({ fetchCompanyCreationDisclosure: vi.fn() }));
vi.mock("@/api/billingDisclosure", () => mockBillingDisclosure);
```

and the cases (the existing tests keep passing because the default mock resolves `null`; set that default in the file's top-level `beforeEach`: `mockBillingDisclosure.fetchCompanyCreationDisclosure.mockResolvedValue(null);`):

```tsx
it("shows the billing price disclosure when the billing plugin responds", async () => {
  mockBillingDisclosure.fetchCompanyCreationDisclosure.mockResolvedValue({
    requiresSubscription: true,
    trialAvailable: false,
    trialDays: 0,
    priceCents: 4900,
    currency: "EUR",
    message: "New companies require a €49.00/month subscription.",
  });
  const { container, root, queryClient, onOpenChange } = renderDialog();
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewCompanyDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  expect(document.body.textContent).toContain("New companies require a €49.00/month subscription.");
  root.unmount();
  container.remove();
});

it("renders no disclosure line when the billing plugin is absent (null result)", async () => {
  mockBillingDisclosure.fetchCompanyCreationDisclosure.mockResolvedValue(null);
  const { container, root, queryClient, onOpenChange } = renderDialog();
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewCompanyDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  expect(document.body.textContent).not.toContain("subscription");
  root.unmount();
  container.remove();
});
```

- [ ] Run `pnpm --filter @paperclipai/ui exec vitest run src/components/NewCompanyDialog.test.tsx` — expect failure (`@/api/billingDisclosure` does not exist).
- [ ] Create `ui/src/api/billingDisclosure.ts`:

```ts
import { api } from "@/api/client";

export interface CompanyCreationDisclosure {
  requiresSubscription: boolean;
  trialAvailable: boolean;
  trialDays: number;
  priceCents: number;
  currency: string;
  message: string;
}

/**
 * Price disclosure from the billing plugin's scoped API route
 * (spec 2026-07-18-billing-plugin-design.md §6.3). The plugin is optional:
 * any failure (not installed, disabled, non-200) resolves to null and the
 * create-company dialog renders without a disclosure line.
 */
export async function fetchCompanyCreationDisclosure(
  activeCompanyId: string,
): Promise<CompanyCreationDisclosure | null> {
  try {
    return await api.get<CompanyCreationDisclosure>(
      `/plugins/paperclip-plugin-billing/api/creation-summary?companyId=${encodeURIComponent(activeCompanyId)}`,
    );
  } catch {
    return null;
  }
}
```

- [ ] Modify `ui/src/components/NewCompanyDialog.tsx` — add the imports, query, and disclosure line:

```tsx
// add to imports:
import { useQuery } from "@tanstack/react-query";
import { fetchCompanyCreationDisclosure } from "@/api/billingDisclosure";
import { useOptionalCompany } from "@/context/CompanyContext";
```

inside the component body (after `const [name, setName] = useState("");`):

```tsx
  const company = useOptionalCompany();
  const activeCompanyId = company?.selectedCompanyId ?? null;
  const disclosure = useQuery({
    queryKey: ["billing-creation-disclosure", activeCompanyId],
    queryFn: () => fetchCompanyCreationDisclosure(activeCompanyId as string),
    enabled: open && activeCompanyId !== null,
    staleTime: 60_000,
    retry: false,
  });
```

and in the JSX, directly below the `<Input …/>` block (`</div>` closing the `py-2` wrapper):

```tsx
        {disclosure.data && (
          <p className="text-sm text-muted-foreground" data-testid="billing-disclosure">
            {disclosure.data.message}
          </p>
        )}
```

  If `useOptionalCompany`'s context value exposes the selected id under a different name than `selectedCompanyId`, read the `CompanyContextValue` interface at the top of `ui/src/context/CompanyContext.tsx` and use its exact field — do not guess.
- [ ] Run `pnpm --filter @paperclipai/ui exec vitest run src/components/NewCompanyDialog.test.tsx` — the two new tests AND all pre-existing tests pass.
- [ ] Commit:

```bash
git add ui/src/api/billingDisclosure.ts ui/src/components/NewCompanyDialog.tsx ui/src/components/NewCompanyDialog.test.tsx
git commit -m "feat(ui): billing price disclosure in create-company dialog (fails silent without plugin)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 18: Stub end-to-end journey (spec §9)

**Files:**
- Test: `packages/plugins/plugin-billing/tests/e2e-journey.spec.ts` (test-only task; no new source files)

**Interfaces:**
- Consumes: `createWorker` (Task 15), `createTestHarness`, in-process stub transport looped into `plugin.definition.onWebhook` — the full production pipeline (signed webhook → verify → ledger → transition → standing) with zero external services, exactly as CI runs it.

Steps:

- [ ] Write the test `packages/plugins/plugin-billing/tests/e2e-journey.spec.ts` (a pure test task — it must pass if Tasks 1–16 are correct; any failure here is a real integration bug to fix in the task that owns the broken module):

```ts
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { WEBHOOK_ENDPOINT_KEY } from "../src/constants.js";
import { MemoryStubStateStore, type StubProvider } from "../src/provider/stub.js";
import { MemoryBillingStore } from "../src/store-memory.js";
import { createWorker } from "../src/worker.js";

const DAY = 86_400_000;
const T0 = new Date("2026-07-18T12:00:00.000Z");

function mkCompany(id: string, owner: string): Company {
  return {
    id, name: `Company ${id}`, description: null, status: "active", pauseReason: null, pausedAt: null,
    issuePrefix: "PC", issueCounter: 0, budgetMonthlyCents: 0, spentMonthlyCents: 0, attachmentMaxBytes: 0,
    defaultResponsibleUserId: owner, requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false, feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null, feedbackDataSharingTermsVersion: null,
    brandColor: null, logoAssetId: null, logoUrl: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"), updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  } as Company;
}

describe("stub provider e2e journey (spec §9)", () => {
  function makeJourney(options: { config?: Record<string, unknown> } = {}) {
    let now = T0;
    let companies: Company[] = [mkCompany("co-1", "user-1")];
    const store = new MemoryBillingStore(() => now);
    const standings: Array<{ kind: string; companyId: string; status?: string; reason?: string }> = [];
    let stub!: StubProvider;

    const plugin = createWorker({
      store,
      stubStateStore: new MemoryStubStateStore(),
      transport: {
        deliver: (headers, rawBody) =>
          plugin.definition.onWebhook!({
            endpointKey: WEBHOOK_ENDPOINT_KEY,
            headers,
            rawBody,
            parsedBody: JSON.parse(rawBody),
            requestId: "req",
          }),
      },
      now: () => now,
      onStubReady: (instance) => { stub = instance; },
    });

    const harness = createTestHarness({ manifest, config: options.config });
    Object.assign(harness.ctx.companies, {
      list: async () => companies,
      setStanding: async (companyId: string, input: { status: string; reason: string }) => {
        standings.push({ kind: "set", companyId, status: input.status, reason: input.reason });
      },
      clearStanding: async (companyId: string) => {
        standings.push({ kind: "clear", companyId });
      },
    });

    return {
      plugin,
      harness,
      store,
      standings,
      getStub: () => stub,
      setNow: (d: Date) => { now = d; },
      getNow: () => now,
      addCompany: (id: string) => { companies = [...companies, mkCompany(id, "user-1")]; },
      removeCompany: (id: string) => { companies = companies.filter((company) => company.id !== id); },
      standingFor: (companyId: string) => standings.filter((s) => s.companyId === companyId).at(-1),
    };
  }

  it("runs the full lifecycle end to end", async () => {
    const j = makeJourney();
    await j.plugin.definition.setup(j.harness.ctx);
    const board = { companyId: "co-1", actor: { type: "user" as const, userId: "user-1" } };

    // 1. signup → first company gets a trial via company.created
    await j.harness.emit("company.created", {}, { companyId: "co-1", entityId: "co-1", entityType: "company" });
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("trialing");

    // 2. trial expiry → grace → wall (blocked): runs blocked, reads keep working (standing-only enforcement)
    j.setNow(new Date(T0.getTime() + 8 * DAY));
    await j.harness.runJob("billing-sweep");
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("grace");
    expect(j.standingFor("co-1")).toMatchObject({ kind: "set", status: "grace", reason: "trial_ended" });
    j.setNow(new Date(T0.getTime() + 16 * DAY));
    await j.harness.runJob("billing-sweep");
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("blocked");
    expect(j.standingFor("co-1")).toMatchObject({ kind: "set", status: "blocked" });

    // 3. stub checkout → signed webhook → active → standing cleared (runs unblocked)
    const checkout = await j.harness.performAction<{ sessionRef: string; url: string }>("create-checkout", {}, board);
    expect(checkout.url).toContain("billing-checkout?session=");
    await j.harness.performAction("stub-checkout-complete", { sessionRef: checkout.sessionRef, outcome: "pay", savePaymentMethod: true }, board);
    const activated = (await j.store.getSubscriptionByCompany("co-1"))!;
    expect(activated.status).toBe("active");
    expect(activated.providerSubscriptionId).not.toBeNull();
    expect(j.standingFor("co-1")).toEqual({ kind: "clear", companyId: "co-1" });

    // 4. second company, card on file → blocked on creation, then one-click activates
    j.addCompany("co-2");
    await j.harness.emit("company.created", {}, { companyId: "co-2", entityId: "co-2", entityType: "company" });
    expect((await j.store.getSubscriptionByCompany("co-2"))!.status).toBe("awaiting_payment"); // no second trial
    expect(j.standingFor("co-2")).toMatchObject({ kind: "set", status: "blocked", reason: "awaiting_subscription" });
    const oneClick = await j.harness.performAction<{ status: string }>("one-click-subscribe", {}, { ...board, companyId: "co-2" });
    expect(oneClick.status).toBe("active");
    expect((await j.store.getSubscriptionByCompany("co-2"))!.status).toBe("active");
    expect(j.standingFor("co-2")).toEqual({ kind: "clear", companyId: "co-2" });

    // 5. SCA requires_action path on a third company
    const summary1 = await j.harness.getData<{ hasDefaultPaymentMethod: boolean }>("billing-summary", { companyId: "co-1" });
    expect(summary1.hasDefaultPaymentMethod).toBe(true);
    j.addCompany("co-3");
    await j.harness.emit("company.created", {}, { companyId: "co-3", entityId: "co-3", entityType: "company" });
    const customer = (await j.store.getCustomerByUser("stub", "user-1"))!;
    await j.getStub().setScaRequired(customer.providerCustomerId, true);
    const sca = await j.harness.performAction<{ status: string; url?: string }>("one-click-subscribe", {}, { ...board, companyId: "co-3" });
    expect(sca.status).toBe("requires_action");
    const scaSessionRef = new URL(sca.url!, "http://x.invalid").searchParams.get("session")!;
    await j.harness.performAction("stub-checkout-complete", { sessionRef: scaSessionRef, outcome: "pay", savePaymentMethod: false }, { ...board, companyId: "co-3" });
    expect((await j.store.getSubscriptionByCompany("co-3"))!.status).toBe("active");
    await j.getStub().setScaRequired(customer.providerCustomerId, false);

    // 6. renewal: payment.succeeded extends the period
    const beforeRenewal = (await j.store.getSubscriptionByCompany("co-1"))!;
    j.setNow(new Date(Date.parse(beforeRenewal.currentPeriodEnd!) + DAY));
    await j.harness.runJob("billing-sweep");
    const renewed = (await j.store.getSubscriptionByCompany("co-1"))!;
    expect(Date.parse(renewed.currentPeriodEnd!)).toBeGreaterThan(Date.parse(beforeRenewal.currentPeriodEnd!));
    expect(renewed.status).toBe("active");

    // 7. cancel at period end → "ends on" state → resume clears it
    const afterCancel = await j.harness.performAction<{ cancelAtPeriodEnd: boolean }>("cancel-at-period-end", {}, board);
    expect(afterCancel.cancelAtPeriodEnd).toBe(true);
    const afterResume = await j.harness.performAction<{ cancelAtPeriodEnd: boolean }>("resume-subscription", {}, board);
    expect(afterResume.cancelAtPeriodEnd).toBe(false);

    // 8. company deletion → local cancel + provider cancel (sweep-only: no company.deleted event exists)
    j.removeCompany("co-2");
    await j.harness.runJob("billing-sweep");
    expect((await j.store.getSubscriptionByCompany("co-2"))!.status).toBe("canceled");

    // 9. provider-side cancellation → resubscribe (canceled → checkout → active)
    const sub1 = (await j.store.getSubscriptionByCompany("co-1"))!;
    await j.getStub().cancelNow(sub1.providerSubscriptionId!);
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("canceled");
    expect(j.standingFor("co-1")).toMatchObject({ kind: "set", status: "blocked", reason: "subscription_ended" });
    const resub = await j.harness.performAction<{ sessionRef: string }>("create-checkout", {}, board);
    await j.harness.performAction("stub-checkout-complete", { sessionRef: resub.sessionRef, outcome: "pay", savePaymentMethod: false }, board);
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("active");
    expect(j.standingFor("co-1")).toEqual({ kind: "clear", companyId: "co-1" });
  }, 30_000);

  it("payment failure → dunning → auto-unblock, plus failed/canceled checkout leaves state unchanged", async () => {
    const j = makeJourney({ config: { trialPolicy: "none" } });
    await j.plugin.definition.setup(j.harness.ctx);
    const board = { companyId: "co-1", actor: { type: "user" as const, userId: "user-1" } };

    // creation → awaiting_payment; a failed then canceled checkout changes nothing
    await j.harness.runJob("billing-sweep");
    const checkout = await j.harness.performAction<{ sessionRef: string }>("create-checkout", {}, board);
    await j.harness.performAction("stub-checkout-complete", { sessionRef: checkout.sessionRef, outcome: "fail" }, board);
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("awaiting_payment");
    await j.harness.performAction("stub-checkout-complete", { sessionRef: checkout.sessionRef, outcome: "cancel" }, board);
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("awaiting_payment");

    // canceled session expired → next create-checkout mints a fresh session and pays
    const fresh = await j.harness.performAction<{ sessionRef: string }>("create-checkout", {}, board);
    expect(fresh.sessionRef).not.toBe(checkout.sessionRef);
    await j.harness.performAction("stub-checkout-complete", { sessionRef: fresh.sessionRef, outcome: "pay", savePaymentMethod: false }, board);
    const active = (await j.store.getSubscriptionByCompany("co-1"))!;
    expect(active.status).toBe("active");

    // renewal fails → grace (dunning); retry a day later succeeds → active, standing cleared (auto-unblock)
    await j.getStub().setFailNextRenewal(active.providerSubscriptionId!, true);
    const failAt = new Date(Date.parse(active.currentPeriodEnd!) + 1);
    j.setNow(failAt);
    await j.harness.runJob("billing-sweep");
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("grace");
    expect(j.standingFor("co-1")).toMatchObject({ kind: "set", status: "grace", reason: "payment_past_due" });

    await j.getStub().setFailNextRenewal(active.providerSubscriptionId!, false);
    j.setNow(new Date(failAt.getTime() + DAY));
    await j.harness.runJob("billing-sweep");
    expect((await j.store.getSubscriptionByCompany("co-1"))!.status).toBe("active");
    expect(j.standingFor("co-1")).toEqual({ kind: "clear", companyId: "co-1" });
  }, 30_000);
});
```

- [ ] Run `pnpm --filter @paperclipai/plugin-billing exec vitest run tests/e2e-journey.spec.ts` — expect both journeys to pass (`onStubReady` was added to `WorkerOverrides` in Task 15).
- [ ] Run the FULL suite `pnpm --filter @paperclipai/plugin-billing test` and `pnpm --filter @paperclipai/plugin-billing typecheck`.
- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/tests/e2e-journey.spec.ts
git commit -m "test(plugin-billing): stub-provider end-to-end lifecycle journey in CI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 19: Stripe guardrails + plugin README (documentation-only)

**Files:**
- Create: `packages/plugins/plugin-billing/STRIPE_ADAPTER.md`
- Create: `packages/plugins/plugin-billing/README.md`

Steps:

- [ ] Create `packages/plugins/plugin-billing/STRIPE_ADAPTER.md` recording spec §5.2 verbatim plus the host-API gaps discovered during v1:

```markdown
# Stripe adapter guardrails (recorded now, built later)

No Stripe code ships in v1. When the Stripe `BillingProvider` implementation is
built, it MUST follow these guardrails, recorded verbatim from the design spec
(docs/superpowers/specs/2026-07-18-billing-plugin-design.md §5.2):

> Never pass `payment_method_types` (dynamic payment methods); Checkout Sessions
> `mode: "subscription"` with `subscription_data.trial_end` for trial
> preservation; per-company override pricing via Prices/`price_data` (no single
> static price id); Customer Portal for self-service (payment methods, invoices,
> receipts); restricted API key (`rk_`) resolved via secret-ref, never in config
> JSON; `integration_identifier` tagging on session create; Stripe Tax trap —
> `automatic_tax` silently collects nothing without an active tax registration;
> webhook signing secret verification with raw body.

## Mapping onto the v1 provider port (`src/provider/types.ts`)

- `verifyAndParseWebhook(headers, rawBody)`: use `stripe.webhooks.constructEvent`
  with the RAW body string — the host preserves the exact signed bytes for the
  worker (`server/src/routes/plugins.ts` stashes `req.rawBody` before JSON
  parsing precisely for HMAC verification).
- Set `metadata.companyId` on every Checkout Session and Subscription so the
  webhook resolution fallback (sessionRef → subRef → `rawPayload.companyId`,
  see `src/webhook.ts`) keeps working for Stripe events.
- `resolveCheckout` = `checkout.sessions.retrieve(sessionRef).status` mapping
  (`complete` | `open` | `expired`).
- `createPortal` = Billing Portal session; v1's stub returns no portal, the UI
  already hides the button when `portal()` yields `{ url: null }`.
- The webhook signing secret and the `rk_` key resolve through `ctx.secrets`
  (`secrets.read-ref` capability is already declared in the manifest set —
  add the secret-ref fields to `instanceConfigSchema` with
  `"format": "secret-ref"` when the adapter lands).

## Host-API gaps to close before the adapter

1. **Customer email/name**: the plugin SDK exposes no user email or display
   name (`PluginAccessMember` carries only `principalId`), so v1 calls
   `ensureCustomer` with `user-<id>@billing.invalid`. Stripe customers need the
   real email for receipts/invoices — add a host capability/API for
   plugin-readable user contact info first.
2. **Dunning windows**: `graceDays` must be aligned with the Stripe dunning
   retry schedule configured in the dashboard (spec §3 note).
```

- [ ] Create `packages/plugins/plugin-billing/README.md`:

```markdown
# @paperclipai/plugin-billing

Self-contained billing for multi-tenant paperclip instances: flat monthly fee
per company, configurable trial, provider-pluggable checkout with a fully
functional stub provider, and a first-class subscription page. Core knows
nothing about money — the only core touchpoints are generic primitives
(`costs.read`, plugin DB namespace, webhooks, jobs, UI slots, and
`company.standing.write`).

Design spec: `docs/superpowers/specs/2026-07-18-billing-plugin-design.md`.

## How it works

- One `subscriptions` row per company; every state mutation is caused by
  exactly one `billing_events` ledger row (webhook, sweep transition, or admin
  action), so replays are no-ops and history is auditable.
- All lifecycle transitions run through one pure function
  (`src/state-machine.ts: transition`), exhaustively table-tested.
- Enforcement is standing-only: `blocked` stops new runs, reads stay available.
  Uninstalling/disabling the plugin clears its standing rows — billing removal
  instantly unblocks all companies, by design.
- The stub provider POSTs HMAC-signed events to the plugin's own webhook
  endpoint, so dev/CI/self-hosters exercise the entire production path with no
  external account. See `STRIPE_ADAPTER.md` for the future real-money adapter.

## Configuration (instance settings → Plugins → Billing)

| Key | Default | Meaning |
| --- | --- | --- |
| `currency` | `EUR` | ISO code used for all prices |
| `defaultMonthlyPriceCents` | `4900` | flat monthly fee per company |
| `trialDays` | `7` | trial length; `0` disables trials |
| `graceDays` | `7` | grace window; align with provider dunning |
| `trialPolicy` | `first-company-per-owner` | or `every-company` / `none` |
| `provider` | `stub` | `stripe` arrives with the adapter |
| `instanceBaseUrl` | `http://127.0.0.1:3100` | where the stub posts its webhooks |

Per-company price overrides (including `0` = complimentary) live on the
instance admin page (Settings → Plugins → Billing).

## Ownership transfer (v1 policy)

Billing stays with the original payer until they cancel; the new owner then
subscribes. No silent card switching (spec §6.2).

## Rollout

1. Bundled but not auto-installed; an instance installs it from the bundled
   plugins list.
2. Fork migration for existing control-plane-billed companies (seeding
   `subscriptions` rows before enforcement cutover) is tracked as its own
   follow-up — deliberately not part of this plugin's v1.
3. Offered upstream once the settings-visibility primitives (PR-1/2/3) land.
```

- [ ] Commit:

```bash
git add packages/plugins/plugin-billing/STRIPE_ADAPTER.md packages/plugins/plugin-billing/README.md
git commit -m "docs(plugin-billing): Stripe adapter guardrails and plugin README

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec coverage map (self-review)

| Billing spec section | Where covered |
| --- | --- |
| §1 Goal / §2 Decisions | Architecture + Global Constraints; `companyEnablement locked` (Task 2); standing-only enforcement (Tasks 5, 6, 11, 13) |
| §3 Package & manifest | Tasks 1–2 (capabilities, database, jobs, webhooks, apiRoutes+companyResolution, ui slots, instanceConfigSchema incl. trialPolicy enum + graceDays default 7) |
| §4 Data model | Task 3 (exact SQL; documented extra columns), Tasks 7–8 (stores) |
| §5 Provider interface + rules | Task 10 `provider/types.ts` (verbatim transliteration); rules enforced in Task 11 pipeline |
| §5.1 Stub provider | Task 10 (HMAC-signed events to own webhook, saved methods, requires_action, renewals, failures, delayed dunning retry, honors trialEndsAt) + Task 16 simulator page |
| §5.2 Stripe guardrails | Task 19 `STRIPE_ADAPTER.md` (verbatim, documentation-only) |
| §6.1 Creation matrix | Task 12 (+ event handler Task 15, sweep pickup Task 13); ledger-based trial eligibility surviving company deletion |
| §6.2 State machine | Task 6 (exhaustive status × event × boundary tests); ownership-transfer note in README (Task 19) |
| §6.3 Checkout UX | Task 14 (idempotent session, resolveCheckout, price disclosure endpoint), Task 16 (confirming-payment polling, CTAs), Task 17 (create-company dialog) |
| §7 UI | Task 16 (Billing page all states, admin page with inline override/extend/resync, simulator); banners deliberately NOT built here — they ride PR-3 standing payload |
| §8 Error handling | Task 11 (ledger-first, post-insert crash), Task 13 (sweep retries/reconciliation, rowless creation, clock purity), Task 4 (fail-safe config); uninstall-clears-standing is PR-3 core behavior, nothing to build here |
| §9 Testing | transition tables (6), webhook idempotency/out-of-order/crash (11), stub e2e journey (18), UI states + disclosure + polling (16–17), authz (14–15); switcher badges are PR-1/PR-3 UI, out of plugin scope |
| §10 Rollout | Task 19 README; bundled discovery is automatic (`server/src/routes/plugins.ts:287` scans `packages/plugins`); fork data migration explicitly deferred |

**Execution order:** strictly 1 → 19. Tasks 4–10 are internally parallelizable after 5 (domain types), but sequential execution is the safe default.

**Deviation register (final):** the five Global Constraints deviations, plus: `grace_since`/`owner_user_id`/`open_checkout_url`/`billing_events.company_id` columns (Task 3 rationale), no-FK-to-companies (Task 3), stub has no `createPortal` (UI hides the button, Task 14/16), placeholder customer email (Global Constraints + Task 19), admin ops on the bridge instead of apiRoutes (deviation 2), and the literal webhook rejection status being 502 rather than 400 (deviation 1).









