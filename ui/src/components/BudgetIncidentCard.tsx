import { useState } from "react";
import type { BudgetIncident } from "@paperclipai/shared";
import { AlertOctagon, ArrowUpRight, PauseCircle } from "lucide-react";
import { formatCents } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseAmountInput(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function incidentStateLabel(incident: BudgetIncident) {
  if (incident.status === "resolved") return "Resolved";
  if (incident.status === "dismissed") return "Dismissed";
  if (incident.approvalStatus === "revision_requested") return "Escalated";
  if (incident.approvalStatus === "pending") return "Pending approval";
  return "Open";
}

export function BudgetIncidentCard({
  incident,
  onRaiseAndResume,
  onKeepPaused,
  onRaiseViaBilling,
  billingManaged,
  isMutating,
}: {
  incident: BudgetIncident;
  onRaiseAndResume: (amountCents: number) => void;
  onKeepPaused: () => void;
  // Cloud billing: the company budget is funded through billing (EUR), so the
  // raise goes through the recurring-budget billing flow instead of a direct
  // policy write (which the server rejects with budget_managed_by_billing).
  onRaiseViaBilling?: (amountCents: number) => void;
  billingManaged?: boolean;
  isMutating?: boolean;
}) {
  const [draftAmount, setDraftAmount] = useState(
    centsInputValue(Math.max(incident.amountObserved + 1000, incident.amountLimit)),
  );
  const parsed = parseAmountInput(draftAmount);
  const stateLabel = incidentStateLabel(incident);

  return (
    <Card className="overflow-hidden border-red-500/20 bg-[linear-gradient(180deg,rgba(255,70,70,0.10),rgba(255,255,255,0.02))]">
      <CardHeader className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[11px] uppercase tracking-[0.22em] text-red-200/80">
                {incident.scopeType} hard stop
              </div>
              <Badge variant={incident.status === "resolved" ? "outline" : "secondary"}>
                {stateLabel}
              </Badge>
            </div>
            <CardTitle className="mt-1 text-base text-red-50">{incident.scopeName}</CardTitle>
            <CardDescription className="mt-1 text-red-100/70">
              Spending reached {formatCents(incident.amountObserved)} against a limit of {formatCents(incident.amountLimit)}.
            </CardDescription>
          </div>
          <div className="rounded-full border border-red-400/30 bg-red-500/10 p-2 text-red-200">
            <AlertOctagon className="h-4 w-4" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        <div className="flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-50/90">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {incident.scopeType === "project"
              ? "Project execution is paused. New work in this project will not start until you resolve the budget incident."
              : "This scope is paused. New heartbeats will not start until you resolve the budget incident."}
          </div>
        </div>

        <div className="rounded-xl border border-border/60 bg-background/60 p-3">
          <label className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {billingManaged ? "New budget (EUR)" : "New budget (USD)"}
          </label>
          {billingManaged ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Raise your budget through billing. Work resumes once the budget is updated.
            </p>
          ) : null}
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Input
              value={draftAmount}
              onChange={(event) => setDraftAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
            <Button
              className="gap-2"
              disabled={isMutating || parsed === null || parsed <= incident.amountObserved}
              onClick={() => {
                if (typeof parsed !== "number") return;
                if (billingManaged) onRaiseViaBilling?.(parsed);
                else onRaiseAndResume(parsed);
              }}
            >
              <ArrowUpRight className="h-4 w-4" />
              {isMutating
                ? "Applying..."
                : billingManaged
                  ? "Raise budget through billing"
                  : "Raise budget & resume"}
            </Button>
          </div>
          {parsed !== null && parsed <= incident.amountObserved ? (
            <p className="mt-2 text-xs text-red-200/80">
              The new budget must exceed current observed spend.
            </p>
          ) : null}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" className="text-muted-foreground" disabled={isMutating} onClick={onKeepPaused}>
            Keep paused
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
