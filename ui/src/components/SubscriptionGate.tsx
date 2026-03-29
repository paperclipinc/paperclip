import { useCallback, useEffect, useState } from "react";
import { onPaymentRequired, ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";

/**
 * Global listener for 402 Payment Required errors.
 * Shows a toast directing the user to billing settings.
 * Render this once inside the provider tree.
 */
export function SubscriptionGate() {
  const { selectedCompany } = useCompany();
  const { pushToast } = useToast();
  const [blocked, setBlocked] = useState(false);

  const handlePaymentRequired = useCallback(
    (error: ApiError) => {
      setBlocked(true);
      const body = error.body as { code?: string } | null;
      const isTrialExpired = body?.code === "TRIAL_EXPIRED";
      const prefix = selectedCompany?.issuePrefix;
      const billingPath = prefix
        ? `/${prefix}/company/settings`
        : "/company/settings";

      pushToast({
        dedupeKey: "payment-required",
        title: isTrialExpired ? "Free trial ended" : "Subscription required",
        body: isTrialExpired
          ? "Your 14-day free trial has ended. Subscribe to continue."
          : error.message,
        tone: "error",
        ttlMs: 15000,
        action: {
          label: "Go to billing",
          href: billingPath,
        },
      });
    },
    [selectedCompany?.issuePrefix, pushToast],
  );

  useEffect(() => {
    return onPaymentRequired(handlePaymentRequired);
  }, [handlePaymentRequired]);

  if (!blocked) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 border-b border-red-300 bg-red-50 px-4 py-2 text-center dark:border-red-800 dark:bg-red-950/80">
      <p className="text-sm font-medium text-red-800 dark:text-red-300">
        Your subscription is inactive.{" "}
        <a
          href={
            selectedCompany
              ? `/${selectedCompany.issuePrefix}/company/settings`
              : "/company/settings"
          }
          className="underline hover:text-red-900 dark:hover:text-red-200"
        >
          Update billing
        </a>{" "}
        to continue using Paperclip Cloud.
      </p>
    </div>
  );
}
