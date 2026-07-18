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

  const { data: summary, loading, error: loadError } = usePluginData<BillingSummary>("billing-summary", { companyId, tick });
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
    let interval = setInterval(() => {
      if (!cancelled) setTick((value) => value + 1);
    }, 2000);
    const slowTimer = setTimeout(() => {
      if (!cancelled) {
        setConfirmSlow(true);
        // Back off from 2s to 15s polling after slow threshold
        clearInterval(interval);
        interval = setInterval(() => {
          if (!cancelled) setTick((value) => value + 1);
        }, 15000);
      }
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
  if (!summary) {
    return (
      <p role="alert">
        Billing information is unavailable{loadError ? `: ${loadError.message}` : "."}
      </p>
    );
  }

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
        <StatusBadge label={summary.status} status={summary.status === "active" || summary.status === "complimentary" ? "ok" : summary.status === "grace" || summary.status === "trialing" || summary.status === "awaiting_payment" ? "warning" : "error"} />
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
