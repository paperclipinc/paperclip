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
    free: "bg-muted text-muted-foreground",
  };
  const color = colorMap[status] ?? colorMap.free;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {status}
    </span>
  );
}

function PlanCard({
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
          {isUpgrading ? "Redirecting..." : "Upgrade"}
        </Button>
      )}
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

  if (subscriptionQuery.isLoading || plansQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading billing info...</div>;
  }

  const subscription = subscriptionQuery.data;
  const plans = plansQuery.data ?? [];
  const currentPlanId = subscription?.planId ?? "free";
  const isPaid = subscription && subscription.status !== "free" && subscription.status !== "canceled";

  return (
    <div className="space-y-4">
      {/* Current plan info */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Current plan:</span>
        <span className="text-sm font-medium">
          {subscription?.plan?.name ?? "Free"}
        </span>
        <StatusBadge status={subscription?.status ?? "free"} />
      </div>

      {subscription?.currentPeriodEnd && (
        <div className="text-xs text-muted-foreground">
          {subscription.cancelAtPeriodEnd
            ? `Cancels on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
            : `Renews on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`}
        </div>
      )}

      {/* Manage billing for paid plans */}
      {isPaid && (
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
      {plans.length > 0 && !isPaid && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Available plans:</div>
          <div className="grid gap-3 sm:grid-cols-2">
            {plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                isCurrent={plan.id === currentPlanId}
                onUpgrade={() => checkoutMutation.mutate(plan.id)}
                isUpgrading={checkoutMutation.isPending}
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
        </div>
      )}
    </div>
  );
}
