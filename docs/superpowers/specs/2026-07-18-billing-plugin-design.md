# `paperclip-plugin-billing` — Design

Date: 2026-07-18
Status: Approved design, pending implementation plan
Depends on: `2026-07-18-settings-visibility-and-plugin-enablement-design.md` (PR-1 capabilities payload, PR-2 enablement + `locked`, PR-3 company standing). Ships fork-first riding those primitives; offered upstream once they land.

## 1. Goal

A self-contained, best-practice billing plugin for multi-tenant paperclip instances: flat monthly fee per company, configurable trial, provider-pluggable checkout with a fully functional stub provider, and a first-class subscription page — with zero external infrastructure required. Any self-hoster running a shared instance can bill companies out of the box; a Stripe adapter drops in later without touching core.

Core knows nothing about money. The only core touchpoints are the generic primitives: `costs.read`, plugin DB namespace, webhooks, jobs, UI slots, and `company.standing.write` (PR-3).

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| Pricing model v1 | Flat monthly fee per company (default + per-company override); usage stays visible via cost dashboards but is not billed |
| Plugin shape | Fully self-contained in the instance (own DB namespace, provider interface + stub, webhook endpoints) |
| Enforcement | Block new runs, keep read access; via PR-3 standing, never via budget-policy abuse |
| Trial policy default | One trial per owner (their first company); configurable |
| Company opt-out | None: `companyEnablement: { default: "on", locked: true }` — a company cannot dodge billing by disabling the plugin |

## 3. Package and manifest

- Path: `packages/plugins/plugin-billing` (bundled, like `plugin-llm-wiki`); id `paperclip-plugin-billing`.
- Capabilities: `company.standing.write`, `costs.read`, `database.namespace.read|write|migrate`, `jobs.schedule`, `webhooks.receive`, `api.routes.register`, `events.subscribe`, UI capability for slots.
- Manifest declarations: `database` (namespace + migrationsDir), `jobs` (daily `billing-sweep` cron), `webhooks` (`endpointKey: "provider"` → `POST /api/plugins/paperclip-plugin-billing/webhooks/provider`), `apiRoutes` (board-auth routes for checkout/portal/summary with `companyResolution`), `ui.slots`: `companySettingsPage` ("Billing", routePath `billing`), `settingsPage` (instance admin), `page` (stub checkout simulator).
- `instanceConfigSchema`:

```jsonc
{
  "currency": "EUR",                 // ISO code
  "defaultMonthlyPriceCents": 4900,
  "trialDays": 7,
  "graceDays": 7,                    // aligned with provider dunning windows
  "trialPolicy": "first-company-per-owner" | "every-company" | "none",
  "provider": "stub"                 // enum; "stripe" added later
  // provider secrets resolve via ctx.secrets / secret-ref, never stored raw in config
}
```

## 4. Data model (plugin namespace)

**`billing_customers`** — one row per paying user:

| Column | Notes |
| --- | --- |
| `user_id` | the payer (company owner at subscribe time) |
| `provider` / `provider_customer_id` | provider linkage |
| `has_default_payment_method` | drives one-click confirm |

**`subscriptions`** — one row per company:

| Column | Notes |
| --- | --- |
| `company_id` | unique |
| `customer_id` | fk `billing_customers`, nullable until first checkout |
| `status` | `trialing` \| `awaiting_payment` \| `active` \| `grace` \| `blocked` \| `canceled` \| `complimentary` |
| `trial_ends_at` | nullable |
| `current_period_end` | nullable |
| `cancel_at_period_end` | bool |
| `price_cents_override` | nullable; `0` ⇒ `complimentary` |
| `provider_subscription_id` | nullable |
| `open_checkout_session_ref` | nullable; enforces one live checkout session per company |

**`billing_events`** — append-only ledger: `idempotency_key` (unique), `type`, `raw_payload`, `subscription_id`, `applied_at`. Every state mutation is caused by exactly one ledger row (webhook, cron transition, or admin action), making replays no-ops and history auditable.

## 5. Provider interface

Worker-internal, Stripe-shaped so the future adapter is mechanical:

```ts
interface BillingProvider {
  ensureCustomer(user: { id, email, name }): Promise<{ customerId }>;
  createCheckout(req: {
    customerId; companyId; priceCents; currency;
    trialEndsAt?: Date;            // subscribe-during-trial keeps remaining trial
    successUrl; cancelUrl;         // successUrl carries {SESSION_REF}
  }): Promise<{ url; sessionRef }>;
  resolveCheckout?(sessionRef): Promise<"complete" | "open" | "expired">; // instant success-page confirmation
  subscribeWithSavedMethod(req: { customerId; companyId; priceCents; currency; trialEndsAt? }):
    Promise<{ status: "active" } | { status: "requires_action"; url }>;   // SCA fallback
  createPortal?(customerId): Promise<{ url }>;
  cancelAtPeriodEnd(subRef): Promise<void>;
  resume(subRef): Promise<void>;
  cancelNow(subRef): Promise<void>;         // company deletion
  verifyAndParseWebhook(headers, rawBody):
    | { type: "checkout.completed"; sessionRef; subRef; periodEnd }
    | { type: "payment.succeeded"; subRef; periodEnd }   // renewals extend period
    | { type: "payment.failed"; subRef }
    | { type: "subscription.canceled"; subRef };
}
```

Rules (apply to every provider):

- Webhook signatures are always verified (HMAC or provider SDK); unverifiable ⇒ 400, never a state change.
- Webhook handler 200-acks only after ledger insert; unique `idempotency_key` makes duplicates no-ops.
- Provider outage never changes standing — only explicit events and the cron sweep do.
- Redirect/query params are never trusted for state; `resolveCheckout` is a server-side provider query, and the webhook remains the source of truth.

### 5.1 Stub provider

Fully functional in-process provider for dev/CI/self-hosters-without-a-PSP:

- `createCheckout` returns a URL to the plugin's `page` slot: a simulator offering pay / fail / cancel, plus a "save payment method" toggle.
- Simulator actions POST correctly HMAC-signed events to the plugin's own manifest webhook endpoint — the entire production path (signature verify → ledger → transition → standing) is exercised end-to-end with no external account.
- Simulates saved payment methods (one-click confirm incl. a `requires_action` branch), renewals (`payment.succeeded`), failures, and dunning (delayed retry event), honoring `trialEndsAt`.

### 5.2 Stripe adapter guardrails (recorded now, built later)

Never pass `payment_method_types` (dynamic payment methods); Checkout Sessions `mode: "subscription"` with `subscription_data.trial_end` for trial preservation; per-company override pricing via Prices/`price_data` (no single static price id); Customer Portal for self-service (payment methods, invoices, receipts); restricted API key (`rk_`) resolved via secret-ref, never in config JSON; `integration_identifier` tagging on session create; Stripe Tax trap — `automatic_tax` silently collects nothing without an active tax registration; webhook signing secret verification with raw body.

## 6. Subscription lifecycle

All transitions run through one pure function `transition(sub, event, config, now)` (exhaustively table-tested). Events come from webhooks, the daily `billing-sweep` cron, company lifecycle events, and admin actions. Every applied event lands in `billing_events` first.

### 6.1 Company creation matrix

| Situation | Result |
| --- | --- |
| Owner's first company, `trialPolicy` allows | `trialing` (`trial_ends_at = now + trialDays`), countdown banner, no card |
| Additional company (or `trialPolicy: "none"`), no payment method on file | `awaiting_payment` → standing `blocked("awaiting_subscription", → billing page)`; company browsable, runs blocked until checkout |
| Additional company, payment method on file | Billing page shows one-click confirm ("Add subscription for €X/mo — uses card on file"); SCA fallback to redirect if `requires_action` |
| Admin set `price_cents_override = 0` | `complimentary` — always active, no checkout ever |

Trial eligibility ("first company per owner") = this owner has never had a `trialing` subscription on any company before (checked via the ledger, so deleting the trial company does not reset eligibility). Companies are picked up via the `company.created` event, with the sweep creating rows for any company that has none (event-loss safety).

### 6.2 State machine

- `trialing` —(trial_ends_at passed)→ `grace` (standing `grace`, "trial ended" messaging)
- `grace` —(graceDays passed)→ `blocked` (standing `blocked`, actionUrl → billing page)
- any unpaid state —(checkout.completed / one-click active)→ `active` (standing cleared)
- `active` —(payment.succeeded)→ `active` (extend `current_period_end`)
- `active` —(payment.failed)→ `grace` (provider dunning keeps retrying; `payment.succeeded` auto-unblocks)
- `active` —(owner cancels)→ `active` + `cancel_at_period_end` (badge "ends on …", resumable) —(period end passes)→ `canceled` + standing `blocked("subscription_ended")`
- `canceled` / `blocked` —(re-subscribe)→ `active`
- company deleted —→ `cancelNow` at provider + local `canceled` (never bill a ghost); sweep reconciles subscriptions whose company vanished
- Subscribe during `trialing` passes `trialEndsAt` to the provider: billing starts when the trial ends; subscribing early never costs trial days.
- Ownership transfer (v1, documented): billing stays with the original payer until they cancel; the new owner then subscribes. No silent card switching.

### 6.3 Checkout UX requirements

- Create-company dialog shows a price disclosure line before creation ("New companies require a €X/mo subscription" / "your trial covers this company"), fed by a plugin-provided summary the UI queries (no surprises post-create).
- After a create that needs payment, the UI routes directly to that company's Billing page with the checkout CTA front-and-center.
- Success return lands in "Confirming payment…": server calls `resolveCheckout(sessionRef)` for sub-second confirmation; if still pending, poll briefly, then "taking longer than expected — we'll update this page automatically" (sweep + webhook reconcile). Cancel return leaves state unchanged with a resubscribe CTA.
- Checkout-session creation is idempotent: an `open_checkout_session_ref` is reused; never two live sessions per company.

## 7. UI

- **Company "Billing" page** (`companySettingsPage`, always present since the plugin is `locked`-on): status card (price, currency, trial countdown, period end / "ends on" when canceling), primary CTA (subscribe / one-click confirm / manage in portal / resume), event history from the ledger.
- **Banners**: trial/grace/blocked messaging rides the PR-3 standing payload (Layout banner + company-switcher badges) — no bespoke banner component.
- **Instance admin page** (`settingsPage`): config form (from `instanceConfigSchema`) + per-company table: status, price (inline override, incl. 0 = complimentary), trial end, period end, payer; admin actions: extend trial, comp company, force re-sync from provider.

## 8. Error handling

- Webhooks: verify → ledger insert (unique key) → transition → 200. Any failure after insert is retried idempotently by the sweep from the ledger.
- Standing writes are the last step of a transition; if the write fails, the sweep retries (standing converges to subscription state).
- Clock-skew-safe: all time-based transitions are pure functions of `now`, evaluated by the sweep; nothing depends on job wall-time precision.
- Missing subscription row ⇒ sweep creates one per the creation matrix; unknown data never blocks (PR-3 fail-safe: only explicit `blocked` rows stop work).
- Plugin uninstall/disable clears its standing rows (PR-3) — billing removal instantly unblocks all companies, by design.

## 9. Testing

- `transition()` table tests: every status × event × trial/grace boundary × clock edge.
- Webhook tests: signature verify, idempotent replay, out-of-order delivery, post-insert crash recovery via sweep.
- Provider-stub e2e in CI (no external services): signup → first company trial → expiry → grace → wall → stub checkout → webhook → active → runs unblocked; second company with card on file → one-click (incl. `requires_action` path); renewal; payment failure → dunning → auto-unblock; cancel at period end → resume; company deletion → provider cancel.
- UI tests: billing page states, price disclosure in create-company dialog, confirming-payment polling, switcher badges.
- Authz: billing page respects membership; instance page admin-only; webhook route unauthenticated-but-signed; plugin API routes use `companyResolution`.

## 10. Rollout

1. Lands in the fork behind plugin install (bundled but not auto-installed; the SaaS instance installs it).
2. Fork migration: existing mono/control-plane-billed companies get `subscriptions` rows seeded from control-plane state before `BILLING_ENFORCE` cutover; the inline fork billing delta (cloudBilling flag surfaces, heartbeat metering fold) is retired only after parity is verified — tracked as its own follow-up, not part of this plugin's v1.
3. Offered upstream (as a bundled plugin or `examples/`-adjacent reference) once PR-1/2/3 land.
