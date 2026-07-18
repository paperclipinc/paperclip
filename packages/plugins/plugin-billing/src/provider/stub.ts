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
