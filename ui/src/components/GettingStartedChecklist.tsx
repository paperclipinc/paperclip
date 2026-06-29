import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle } from "lucide-react";
import { Link } from "@/lib/router";
import { activationApi } from "@/api/activation";
import { accessApi } from "@/api/access";
import { inboxDismissalsApi } from "@/api/inboxDismissals";
import { queryKeys } from "@/lib/queryKeys";

const DISMISS_KEY = "getting-started";

export interface GettingStartedChecklistProps {
  companyId: string;
  hasAgents: boolean;
  hasIssues: boolean;
  onHireAgent: () => void;
}

interface ChecklistRow {
  key: string;
  label: string;
  done: boolean;
  cta?: { label: string; onClick?: () => void; to?: string };
}

export function GettingStartedChecklist({
  companyId,
  hasAgents,
  hasIssues,
  onHireAgent,
}: GettingStartedChecklistProps) {
  const queryClient = useQueryClient();

  const { data: dismissals } = useQuery({
    queryKey: queryKeys.inboxDismissals(companyId),
    queryFn: () => inboxDismissalsApi.list(companyId),
  });
  const { data: activation } = useQuery({
    queryKey: queryKeys.activation.status(companyId),
    queryFn: () => activationApi.statusForCompany(companyId),
  });
  const { data: directory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });

  const dismissed = useMemo(
    () => (dismissals ?? []).some((d) => d.itemKey === DISMISS_KEY),
    [dismissals],
  );

  const humanMembers = directory?.users?.length ?? 0;
  const activated = activation?.activated === true;

  const rows: ChecklistRow[] = useMemo(
    () => [
      { key: "company", label: "Create your company", done: true },
      {
        key: "agent",
        label: "Hire your first agent",
        done: hasAgents,
        cta: { label: "Hire your first agent", onClick: onHireAgent },
      },
      {
        key: "task",
        label: "Run your first task",
        done: hasIssues,
        cta: { label: "Start a task", onClick: onHireAgent },
      },
      {
        key: "result",
        label: "See a first result",
        done: activated,
      },
      {
        key: "invite",
        label: "Invite a teammate",
        done: humanMembers >= 2,
        cta: { label: "Invite a teammate", to: "/company/settings/invites" },
      },
    ],
    [hasAgents, hasIssues, activated, humanMembers, onHireAgent],
  );

  const allDone = rows.every((row) => row.done);

  const dismissMutation = useMutation({
    mutationFn: () => inboxDismissalsApi.dismiss(companyId, DISMISS_KEY),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.inboxDismissals(companyId),
      }),
  });

  useEffect(() => {
    if (!dismissed && allDone && !dismissMutation.isPending) {
      dismissMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed, allDone]);

  if (dismissed) return null;

  return (
    <section
      aria-label="Getting started"
      className="rounded-md border border-border px-4 py-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Getting started</h2>
        <button
          type="button"
          onClick={() => dismissMutation.mutate()}
          className="text-xs text-muted-foreground underline underline-offset-2"
        >
          Dismiss
        </button>
      </div>
      <ul className="mt-3 space-y-2">
        {rows.map((row) => (
          <li
            key={row.key}
            data-done={row.done ? "true" : "false"}
            className="flex items-center justify-between gap-3"
          >
            <span className="flex items-center gap-2 text-sm">
              {row.done ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground" />
              )}
              <span
                className={
                  row.done ? "text-muted-foreground line-through" : ""
                }
              >
                {row.label}
              </span>
            </span>
            {!row.done && row.cta ? (
              row.cta.to ? (
                <Link
                  to={row.cta.to}
                  className="text-sm font-medium underline underline-offset-2"
                >
                  {row.cta.label}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={row.cta.onClick}
                  className="text-sm font-medium underline underline-offset-2"
                >
                  {row.cta.label}
                </button>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
