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

  const { data: session, loading, error: loadError } = usePluginData<StubSession | null>("stub-session", { companyId, sessionRef, tick });
  const act = usePluginAction("stub-checkout-complete");

  if (!sessionRef) return <p>Missing checkout session reference.</p>;
  if (loading && !session) return <Spinner />;
  if (!session) {
    return (
      <p role="alert">
        {loadError ? `Could not load this checkout session: ${loadError.message}` : "This checkout session does not exist."}
      </p>
    );
  }

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
