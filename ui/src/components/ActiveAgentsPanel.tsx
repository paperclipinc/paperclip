import { memo, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { requiresExecutionReconciliation, type Issue, type IssueRecoveryAction } from "@paperclipai/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import type { TranscriptEntry } from "../adapters";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { Clock3 } from "lucide-react";
import { Identity } from "./Identity";
import { StatusGlyph } from "./StatusGlyph";
import { RunChatSurface } from "./RunChatSurface";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { Badge } from "@/components/ui/badge";

function RunCardRecoveryChip({ action }: { action: IssueRecoveryAction }) {
  const state = deriveActiveRecoveryDisplayState(action);
  if (!state || requiresExecutionReconciliation(action.cause)) return null;
  const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
  const Icon = tone.icon;
  return (
    <Badge variant="outline"
      data-testid="active-agent-run-recovery-indicator"
      data-recovery-state={state}
      role="status"
      aria-label={tone.label}
      title={`${tone.label} — open the source task to act.`}
      className={cn(
        "gap-0.5 px-1.5 text-(length:--text-nano)",
        tone.className,
      )}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {tone.label}
    </Badge>
  );
}

const MIN_DASHBOARD_RUNS = 4;
const DASHBOARD_RUN_CARD_LIMIT = 4;
const DASHBOARD_LOG_POLL_INTERVAL_MS = 15_000;
const DASHBOARD_LOG_READ_LIMIT_BYTES = 64_000;
const DASHBOARD_MAX_CHUNKS_PER_RUN = 40;
const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];
const EMPTY_RUNS: LiveRunForIssue[] = [];

const runStatusLabels: Record<string, string> = {
  running: "Running",
  queued: "Queued",
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

interface ActiveAgentsPanelProps {
  companyId: string;
  title?: string;
  minRunCount?: number;
  fetchLimit?: number;
  cardLimit?: number;
  gridClassName?: string;
  cardClassName?: string;
  emptyMessage?: string;
  queryScope?: string;
  showMoreLink?: boolean;
  showTranscripts?: boolean;
}

export function ActiveAgentsPanel({
  companyId,
  title = "Agents",
  minRunCount = MIN_DASHBOARD_RUNS,
  fetchLimit,
  cardLimit = DASHBOARD_RUN_CARD_LIMIT,
  gridClassName,
  cardClassName,
  emptyMessage = "No recent agent runs.",
  queryScope = "dashboard",
  showMoreLink = true,
  showTranscripts = false,
}: ActiveAgentsPanelProps) {
  const liveRunsQueryKey = [...queryKeys.liveRuns(companyId), queryScope, { minRunCount, fetchLimit }] as const;
  const sharedLiveRuns = useSharedPollingQuery({
    companyId,
    resourceKey: `live-runs:${queryScope}:${minRunCount}:${fetchLimit ?? "default"}`,
    queryKey: liveRunsQueryKey,
    enabled: !!companyId,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: minRunCount, limit: fetchLimit }),
    enabled: sharedLiveRuns.enabled,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);

  const runs = liveRuns ?? [];
  const visibleRuns = useMemo(() => runs.slice(0, cardLimit), [cardLimit, runs]);
  const hiddenRunCount = Math.max(0, runs.length - visibleRuns.length);
  const visibleIssueIds = useMemo(
    () => [...new Set(visibleRuns.map((run) => run.issueId).filter((issueId): issueId is string => Boolean(issueId)))],
    [visibleRuns],
  );

  const issueQueries = useQueries({
    queries: visibleIssueIds.map((issueId) => ({
      queryKey: queryKeys.issues.detail(issueId),
      queryFn: () => issuesApi.get(issueId),
      staleTime: 30_000,
      retry: false,
    })),
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const query of issueQueries) {
      const issue = query.data;
      if (issue) map.set(issue.id, issue);
    }
    return map;
  }, [issueQueries]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: showTranscripts ? visibleRuns : EMPTY_RUNS,
    companyId,
    maxChunksPerRun: DASHBOARD_MAX_CHUNKS_PER_RUN,
    logPollIntervalMs: DASHBOARD_LOG_POLL_INTERVAL_MS,
    logReadLimitBytes: DASHBOARD_LOG_READ_LIMIT_BYTES,
    enableRealtimeUpdates: false,
  });

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {runs.length === 0 ? (
        <div className="rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </div>
      ) : (
        <div className={cn("grid grid-cols-1 items-start gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4", gridClassName)}>
          {visibleRuns.map((run) => (
            <AgentRunCard
              key={run.id}
              companyId={companyId}
              run={run}
              issue={run.issueId ? issueById.get(run.issueId) : undefined}
              transcript={transcriptByRun.get(run.id) ?? EMPTY_TRANSCRIPT}
              hasOutput={hasOutputForRun(run.id)}
              showTranscript={showTranscripts}
              issueLoadFailed={issueQueries.some((query, index) => visibleIssueIds[index] === run.issueId && query.isError)}
              className={cardClassName}
            />
          ))}
        </div>
      )}
      {showMoreLink && runs.length > 0 && (
        <div className="mt-3 flex justify-end text-xs text-muted-foreground">
          <Link to="/dashboard/live" className="hover:text-foreground hover:underline">
            {hiddenRunCount > 0
              ? `${hiddenRunCount} more active/recent run${hiddenRunCount === 1 ? "" : "s"}`
              : "View all runs"}
          </Link>
        </div>
      )}
    </div>
  );
}

export const AgentRunCard = memo(function AgentRunCard({
  companyId,
  run,
  issue,
  transcript = EMPTY_TRANSCRIPT,
  hasOutput = false,
  showTranscript = false,
  issueLoadFailed = false,
  className,
}: {
  companyId: string;
  run: LiveRunForIssue;
  issue?: Pick<Issue, "identifier" | "title" | "status">;
  transcript?: TranscriptEntry[];
  hasOutput?: boolean;
  showTranscript?: boolean;
  issueLoadFailed?: boolean;
  className?: string;
}) {
  const statusLabel = runStatusLabels[run.status] ?? run.status.replace(/[_-]/g, " ");
  const runUrl = `/agents/${run.agentId}/runs/${run.id}`;
  const timestamp = run.finishedAt
    ? `Finished ${relativeTime(run.finishedAt)}`
    : run.startedAt ? `Started ${relativeTime(run.startedAt)}` : `Queued ${relativeTime(run.createdAt)}`;
  const taskTitle = issue?.title ?? (issueLoadFailed ? "Task unavailable" : "Loading task…");

  return (
    <div className={cn(
      "dashboard-agent-card flex min-w-0 flex-col overflow-hidden rounded-xl border",
      showTranscript && "h-(--sz-320px)",
      run.status === "running"
        ? "border-(--dashboard-run-border) bg-(--dashboard-run-background) shadow-(--shadow-extract-1)"
        : "border-border bg-background/70",
      className,
    )}>
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isActive && (!run.execution || run.execution.phase === "working") ? (
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-blue-400 opacity-70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
                </span>
              ) : (
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
              )}
              <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-(length:--text-micro)" />
            </div>
            <div className="mt-2 flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
              <span>{(run.execution?.phase === "reconnecting" || run.execution?.phase === "retry_scheduled") ? "Reconnecting…" : (isActive ? "Live now" : run.finishedAt ? `Finished ${relativeTime(run.finishedAt)}` : `Started ${relativeTime(run.createdAt)}`)}</span>
            </div>
          </div>

        {run.issueId ? (
          <Link
            to={`/issues/${issue?.identifier ?? run.issueId}`}
            className="min-w-0 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={issue ? `${issue.title} · ${issue.identifier}` : taskTitle}
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <StatusGlyph
                  status={issue?.status ?? "backlog"}
                  size="md"
                  className="self-center"
                  title={issue ? `Task ${issue.status.replace(/_/g, " ")}` : undefined}
                />
                <span className="truncate">{taskTitle}</span>
              </span>
              <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">{issue?.identifier ?? run.issueId.slice(0, 8)}</span>
            </span>
          </Link>
        ) : (
          <Link to={runUrl} className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Clock3 className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{run.invocationSource === "timer" ? "Scheduled heartbeat" : "No linked task"}</span>
          </Link>
        )}
        <time
          dateTime={run.finishedAt ?? run.startedAt ?? run.createdAt}
          className="text-right font-sans text-xs text-muted-foreground/70"
        >
          {timestamp}
        </time>
      </div>

      {showTranscript && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <RunChatSurface
            run={run}
            transcript={transcript}
            hasOutput={hasOutput}
            companyId={companyId}
          />
        </div>
      )}
    </div>
  );
});
