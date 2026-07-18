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
  const { data: rows, loading, error: loadError } = usePluginData<AdminCompanyRow[]>("admin-overview", { tick });
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
      {loadError && !rows && <p role="alert">Could not load companies: {loadError.message}</p>}
      {rows && rows.length === 0 && <p>No companies yet.</p>}
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
