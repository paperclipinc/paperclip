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
