import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, X } from "lucide-react";
import { cloudBillingApi } from "@/api/cloudBilling";
import { useFeatures } from "../hooks/useFeatures";
import { queryKeys } from "../lib/queryKeys";

const DISMISSED_SESSION_KEY = "paperclip-cloud-trial-banner-dismissed";
const DAY_MS = 24 * 60 * 60 * 1000;

export function trialDaysLeft(trialEndsAt: string | null | undefined, now: number = Date.now()): number | null {
  if (!trialEndsAt) return null;
  const end = new Date(trialEndsAt).getTime();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - now) / DAY_MS));
}

function readSessionDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_SESSION_KEY) === "true";
  } catch {
    return false;
  }
}

function writeSessionDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISSED_SESSION_KEY, "true");
  } catch {
    // Session-only nicety; losing it just re-shows the banner.
  }
}

/**
 * Slim cloud-only banner surfacing the billing trial inside the product: the
 * managed cloud starts every account on a trial, but nothing in the app said
 * so (or where to subscribe) until now. Renders nothing off-cloud, for active
 * subscriptions, when dismissed this session, or when the summary fetch fails.
 */
export function CloudTrialBanner() {
  const [dismissed, setDismissed] = useState(readSessionDismissed);

  const { data: experimentalSettings } = useFeatures();
  const cloudTrialBanner = experimentalSettings?.cloudTrialBanner === true;

  // One fetch per page load: the trial state does not change mid-session.
  const { data: summary } = useQuery({
    queryKey: queryKeys.cloudBilling.summary,
    queryFn: () => cloudBillingApi.summary(),
    enabled: cloudTrialBanner && !dismissed,
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  if (!cloudTrialBanner || dismissed || !summary) return null;

  const expired = summary.effectiveStatus === "trial_expired";
  const trialing = !expired && summary.status === "trialing";
  if (!expired && !trialing) return null;

  let message: string;
  if (expired) {
    message = "Your free trial has ended.";
  } else {
    const days = trialDaysLeft(summary.trialEndsAt) ?? 0;
    message =
      days <= 0
        ? "Your free trial ends today."
        : `Free trial: ${days} day${days === 1 ? "" : "s"} left.`;
  }

  return (
    <div className="border-b border-sky-300/60 bg-sky-50 text-sky-950 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-100">
      <div className="flex items-center gap-3 px-3 py-2 text-sm">
        <Clock className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          {message}{" "}
          <a href="/account" className="font-semibold underline underline-offset-2 hover:opacity-80">
            Subscribe now
          </a>
        </span>
        <button
          type="button"
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 transition-colors hover:bg-sky-900/10 dark:hover:bg-sky-100/10"
          onClick={() => {
            writeSessionDismissed();
            setDismissed(true);
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
