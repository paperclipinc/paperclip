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
- `createPortal` = Billing Portal session; the stub has no createPortal,
  BillingService.portal() returns { url: null }, and the v1 UI exposes no
  portal entry point — the Stripe adapter must ADD the "Manage in portal" CTA
  (button + summary field) alongside implementing createPortal.
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
3. **Atomic state mutations**: `ctx.state` offers no `setIfAbsent`/compare-and-swap,
   so the per-install webhook-secret get-or-create races on first boot; the plugin
   converges by re-reading the stored winner after set (see src/hmac.ts
   ensureStubWebhookSecret), but a host-side atomic setIfAbsent would eliminate
   the window — the Stripe adapter's webhook-secret handling inherits the same
   pattern.
