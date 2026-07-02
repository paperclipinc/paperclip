import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { cloudCompaniesApi, type CloudCompanyCreateResult } from "@/api/cloudCompanies";
import { queryKeys } from "@/lib/queryKeys";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface NewCompanyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Cloud-only "create an additional company" dialog. The hosting gateway's
// POST /api/cloud/companies provisions a new control-plane tenant (the native
// POST /api/companies is blocked in cloud). Plan-gating lives in the gateway, so
// the UI optimistically allows the click and lets the 402 drive an inline upgrade
// prompt — a single source of truth for the plan, kept out of the product.
export function NewCompanyDialog({ open, onOpenChange }: NewCompanyDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  const createCompany = useMutation<CloudCompanyCreateResult, unknown, { name: string }>({
    mutationFn: (data) => cloudCompaniesApi.create(data),
    onSuccess: async (result) => {
      // Refresh the companies list so the switcher shows the new company, then
      // hard-navigate to its dashboard. A client-side navigate would NOT trigger
      // a fresh gateway request for the new slug, so the gateway would never
      // inject that company's stack and the product would never auto-create its
      // membership — the user would land on a membership-less, broken company.
      // A full-page load makes the gateway process the slug and auto-create the
      // company + membership (the cloud-actor path), exactly like opening
      // /PC<slug>/dashboard directly.
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      reset();
      onOpenChange(false);
      window.location.assign(result.url);
    },
  });

  function reset() {
    setName("");
    createCompany.reset();
  }

  function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed || createCompany.isPending) return;
    createCompany.mutate({ name: trimmed });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const error = createCompany.error;
  const errorCode =
    error instanceof ApiError ? (error.body as { error?: string } | null)?.error : undefined;
  // Both come back as 402: the plan gate (upgrade_required) and a failed
  // per-company billing update for an already-paying user (billing_update_failed).
  // Only the former is an upsell.
  const isBillingUpdateFailed =
    error instanceof ApiError && error.status === 402 && errorCode === "billing_update_failed";
  const isUpgradeRequired =
    error instanceof ApiError && error.status === 402 && !isBillingUpdateFailed;
  const isLimitReached = error instanceof ApiError && error.status === 409;
  const isGenericError =
    error != null && !isBillingUpdateFailed && !isUpgradeRequired && !isLimitReached;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>Create company</DialogTitle>
          <DialogDescription>
            Start a new company in your account. It gets its own workspace, agents, and budget.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <Input
            placeholder="Company name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={createCompany.isPending}
            autoFocus
            aria-label="Company name"
          />
        </div>

        {isUpgradeRequired && (
          <div
            role="alert"
            className="rounded-md border border-border bg-muted/40 p-3 text-sm"
          >
            <p className="font-medium">Creating more companies is a Pro feature</p>
            <p className="mt-1 text-muted-foreground">
              Your plan includes one company. Upgrade to Pro to run more.{" "}
              <a href="/pricing" className="font-medium underline">
                See plans
              </a>
            </p>
          </div>
        )}

        {isBillingUpdateFailed && (
          <div
            role="alert"
            className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
          >
            We could not update your billing for the new company. No company was created and you
            have not been charged. Try again or contact support.
          </div>
        )}

        {isLimitReached && (
          <div
            role="alert"
            className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
          >
            You've reached your plan's company limit.
          </div>
        )}

        {isGenericError && (
          <div role="alert" className="text-sm text-destructive">
            Could not create the company. Please try again.
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={createCompany.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || createCompany.isPending}
          >
            {createCompany.isPending ? "Creating…" : "Create company"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
