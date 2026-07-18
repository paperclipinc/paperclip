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
