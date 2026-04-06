import { useQuery, useMutation } from "@tanstack/react-query";
import { billingApi } from "../api/billing";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import type { SubscriptionPlan } from "@paperclipai/shared";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    active: "bg-green-500/10 text-green-700 dark:text-green-400",
    trialing: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
    past_due: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
    canceled: "bg-red-500/10 text-red-700 dark:text-red-400",
    trial_expired: "bg-red-500/10 text-red-700 dark:text-red-400",
    free: "bg-muted text-muted-foreground",
    covered_by_account: "bg-purple-500/10 text-purple-700 dark:text-purple-400",
  };
  const color = colorMap[status] ?? colorMap.free;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {status === "trial_expired"
        ? "trial expired"
        : status === "covered_by_account"
          ? "covered by Unlimited"
          : status}
    </span>
  );
}

function trialDaysRemaining(trialEndsAt: string | null | undefined): number | null {
  if (!trialEndsAt) return null;
  const diff = new Date(trialEndsAt).getTime() - Date.now();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export function PlanCard({
  plan,
  isCurrent,
  onUpgrade,
  isUpgrading,
}: {
  plan: SubscriptionPlan;
  isCurrent: boolean;
  onUpgrade: () => void;
  isUpgrading: boolean;
}) {
  return (
    <div
      className={`rounded-md border px-4 py-3 space-y-2 ${
        isCurrent ? "border-primary bg-primary/5" : "border-border"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{plan.name}</span>
        <span className="text-sm font-semibold">
          {plan.monthlyPriceCents === 0 ? "Free" : `${formatCents(plan.monthlyPriceCents)}/mo`}
        </span>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        {plan.maxAgents !== null && (
          <div>Up to {plan.maxAgents} agent{plan.maxAgents !== 1 ? "s" : ""}</div>
        )}
        {plan.maxAgents === null && <div>Unlimited agents</div>}
        {plan.maxMonthlyCostCents !== null && (
          <div>Cost cap: {formatCents(plan.maxMonthlyCostCents)}/mo</div>
        )}
      </div>
      {isCurrent ? (
        <div className="text-xs text-primary font-medium">Current plan</div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={onUpgrade}
          disabled={isUpgrading}
        >
          {isUpgrading ? "Redirecting..." : "Subscribe"}
        </Button>
      )}
    </div>
  );
}

function AccountPlanCard({
  plan,
  onUpgrade,
  isUpgrading,
}: {
  plan: SubscriptionPlan;
  onUpgrade: () => void;
  isUpgrading: boolean;
}) {
  return (
    <div className="rounded-md border-2 border-purple-400 dark:border-purple-600 px-4 py-3 space-y-2 relative">
      <span className="absolute -top-2.5 right-3 rounded-full bg-purple-600 px-2 py-0.5 text-[10px] font-semibold text-white">
        Best value
      </span>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{plan.name}</span>
        <span className="text-sm font-semibold">
          {formatCents(plan.monthlyPriceCents)}/mo flat
        </span>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        <div>All your companies covered under one subscription</div>
        {plan.maxAgents !== null && (
          <div>Up to {plan.maxAgents} agent{plan.maxAgents !== 1 ? "s" : ""} per company</div>
        )}
        {plan.maxAgents === null && <div>Unlimited agents per company</div>}
        {plan.maxMonthlyCostCents !== null && (
          <div>Cost cap: {formatCents(plan.maxMonthlyCostCents)}/mo</div>
        )}
      </div>
      <Button
        size="sm"
        onClick={onUpgrade}
        disabled={isUpgrading}
      >
        {isUpgrading ? "Redirecting..." : "Go Unlimited"}
      </Button>
    </div>
  );
}

export function BillingSection({ companyId }: { companyId: string }) {
  const subscriptionQuery = useQuery({
    queryKey: queryKeys.billing.subscription(companyId),
    queryFn: () => billingApi.getSubscription(companyId),
  });

  const plansQuery = useQuery({
    queryKey: queryKeys.billing.plans,
    queryFn: () => billingApi.listPlans(),
  });

  const accountSubscriptionQuery = useQuery({
    queryKey: queryKeys.billing.accountSubscription,
    queryFn: () => billingApi.getAccountSubscription(),
  });

  const checkoutMutation = useMutation({
    mutationFn: (planId: string) => billingApi.createCheckoutSession(companyId, planId),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const portalMutation = useMutation({
    mutationFn: () => billingApi.createPortalSession(companyId),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const accountCheckoutMutation = useMutation({
    mutationFn: (planId: string) => billingApi.createAccountCheckoutSession(planId),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const accountPortalMutation = useMutation({
    mutationFn: () => billingApi.createAccountPortalSession(),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  if (subscriptionQuery.isLoading || plansQuery.isLoading || accountSubscriptionQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading billing info...</div>;
  }

  const subscription = subscriptionQuery.data;
  const plans = plansQuery.data ?? [];
  const accountSubscription = accountSubscriptionQuery.data;
  const currentPlanId = subscription?.planId ?? "free";
  const isPaid = subscription && subscription.status === "active";
  const isTrialing = subscription?.status === "trialing";
  const isTrialExpired = subscription?.status === "trial_expired";
  const isCanceled = subscription?.status === "canceled";
  const isPastDue = subscription?.status === "past_due";
  const isCoveredByAccount = subscription?.status === "covered_by_account";
  const hasActiveAccountSub = accountSubscription && (accountSubscription.status === "active" || accountSubscription.status === "past_due");
  const daysLeft = trialDaysRemaining(subscription?.trialEndsAt);
  const showUpgrade = !isPaid && !isPastDue && !isCoveredByAccount && !hasActiveAccountSub;

  return (
    <div className="space-y-4">
      {/* Account-level Unlimited banner */}
      {hasActiveAccountSub && (
        <div className="rounded-md border border-purple-300 bg-purple-50 dark:border-purple-800 dark:bg-purple-950/30 px-4 py-3">
          <p className="text-sm font-medium text-purple-800 dark:text-purple-300">
            Unlimited plan — all your companies are covered under one subscription
          </p>
          {accountSubscription.currentPeriodEnd && (
            <p className="text-xs text-purple-700 dark:text-purple-400 mt-1">
              {accountSubscription.cancelAtPeriodEnd
                ? `Cancels on ${new Date(accountSubscription.currentPeriodEnd).toLocaleDateString()}`
                : `Renews on ${new Date(accountSubscription.currentPeriodEnd).toLocaleDateString()}`}
            </p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => accountPortalMutation.mutate()}
              disabled={accountPortalMutation.isPending}
            >
              {accountPortalMutation.isPending ? "Opening..." : "Manage account billing"}
            </Button>
            {accountPortalMutation.isError && (
              <span className="text-xs text-destructive">
                {accountPortalMutation.error instanceof Error
                  ? accountPortalMutation.error.message
                  : "Failed to open billing portal"}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Covered by account banner (when company status is covered_by_account) */}
      {isCoveredByAccount && !hasActiveAccountSub && (
        <div className="rounded-md border border-purple-300 bg-purple-50 dark:border-purple-800 dark:bg-purple-950/30 px-4 py-3">
          <p className="text-sm font-medium text-purple-800 dark:text-purple-300">
            This company is covered by your Unlimited plan
          </p>
        </div>
      )}

      {/* Trial expired banner */}
      {isTrialExpired && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 px-4 py-3">
          <p className="text-sm font-medium text-red-800 dark:text-red-300">
            Your 14-day free trial has ended.
          </p>
          <p className="text-xs text-red-700 dark:text-red-400 mt-1">
            Subscribe to continue using Paperclip Cloud.
          </p>
        </div>
      )}

      {/* Past due banner */}
      {isPastDue && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/30 px-4 py-3">
          <p className="text-sm font-medium text-yellow-800 dark:text-yellow-300">
            Payment failed
          </p>
          <p className="text-xs text-yellow-700 dark:text-yellow-400 mt-1">
            We couldn't process your last payment. Please update your payment method to avoid service interruption.
          </p>
        </div>
      )}

      {/* Canceled banner */}
      {isCanceled && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 px-4 py-3">
          <p className="text-sm font-medium text-red-800 dark:text-red-300">
            Subscription canceled
          </p>
          <p className="text-xs text-red-700 dark:text-red-400 mt-1">
            Resubscribe to continue using Paperclip Cloud.
          </p>
        </div>
      )}

      {/* Current plan info */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Current plan:</span>
        <span className="text-sm font-medium">
          {isCoveredByAccount
            ? "Covered by your Unlimited plan"
            : subscription?.plan?.name ?? "Free"}
        </span>
        <StatusBadge status={subscription?.status ?? "free"} />
      </div>

      {/* Trial countdown */}
      {isTrialing && daysLeft !== null && (
        <div className="text-xs text-muted-foreground">
          {daysLeft === 0
            ? "Your trial ends today"
            : `${daysLeft} day${daysLeft !== 1 ? "s" : ""} left in your free trial`}
        </div>
      )}

      {/* Renewal / cancellation info for paid company plans */}
      {isPaid && subscription?.currentPeriodEnd && !hasActiveAccountSub && (
        <div className="text-xs text-muted-foreground">
          {subscription.cancelAtPeriodEnd
            ? `Cancels on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
            : `Renews on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`}
        </div>
      )}

      {/* Manage billing for paid or past_due company plans (only if not on account sub) */}
      {(isPaid || isPastDue) && !hasActiveAccountSub && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => portalMutation.mutate()}
            disabled={portalMutation.isPending}
          >
            {portalMutation.isPending ? "Opening..." : "Manage billing"}
          </Button>
          {portalMutation.isError && (
            <span className="text-xs text-destructive">
              {portalMutation.error instanceof Error
                ? portalMutation.error.message
                : "Failed to open billing portal"}
            </span>
          )}
        </div>
      )}

      {/* Plan cards for upgrade */}
      {plans.length > 0 && showUpgrade && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            {isTrialing || isTrialExpired || isCanceled ? "Subscribe now:" : "Available plans:"}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {plans
              .filter((plan) => plan.monthlyPriceCents > 0 && plan.scope === "company")
              .map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  isCurrent={plan.id === currentPlanId && !!isPaid}
                  onUpgrade={() => checkoutMutation.mutate(plan.id)}
                  isUpgrading={checkoutMutation.isPending}
                />
              ))}
            {plans
              .filter((plan) => plan.scope === "account")
              .map((plan) => (
                <AccountPlanCard
                  key={plan.id}
                  plan={plan}
                  onUpgrade={() => accountCheckoutMutation.mutate(plan.id)}
                  isUpgrading={accountCheckoutMutation.isPending}
                />
              ))}
          </div>
          {checkoutMutation.isError && (
            <span className="text-xs text-destructive">
              {checkoutMutation.error instanceof Error
                ? checkoutMutation.error.message
                : "Failed to start checkout"}
            </span>
          )}
          {accountCheckoutMutation.isError && (
            <span className="text-xs text-destructive">
              {accountCheckoutMutation.error instanceof Error
                ? accountCheckoutMutation.error.message
                : "Failed to start checkout"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
