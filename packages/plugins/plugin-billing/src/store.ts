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
