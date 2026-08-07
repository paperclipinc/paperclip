import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, approvals, companies, companySecrets, costEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";
import { visibleIssueCondition } from "./issue-visibility.js";
<<<<<<< HEAD
import { BUILT_IN_AGENT_METADATA_KEY } from "./built-in-agent-metadata.js";
=======
>>>>>>> origin/master

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

export interface ActivationSignalsRow {
  companyId: string;
  hasAgent: boolean;
  hasCompletedRun: boolean;
  hasCredential: boolean;
  agentCount: number;
  lastActivityAt: Date | null;
  monthRunCount: number;
  monthCostCents: number;
  firstSucceededAt: string | null;
  weekRunsSucceeded: number;
  weekRunsFailed: number;
  pendingApprovalCount: number;
  pendingApprovals: ActivationSignalsPendingApproval[];
}

export interface ActivationSignalsPendingApproval {
  id: string;
  type: string;
  agentName: string | null;
  createdAt: string;
}

const METERED_BILLING_TYPE = "metered_api";
const SUBSCRIPTION_BILLING_TYPES = ["subscription_included", "subscription_overage"] as const;

function sumAsNumber(column: typeof costEvents.costCents | typeof costEvents.inputTokens | typeof costEvents.cachedInputTokens | typeof costEvents.outputTokens) {
  return sql<number>`coalesce(sum(${column}), 0)::double precision`;
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

async function getMonthlySpendTotal(
  db: Db,
  scope: { companyId: string; agentId?: string | null },
) {
  const { start, end } = currentUtcMonthWindow();
  const conditions = [
    eq(costEvents.companyId, scope.companyId),
    gte(costEvents.occurredAt, start),
    lt(costEvents.occurredAt, end),
  ];
  if (scope.agentId) {
    conditions.push(eq(costEvents.agentId, scope.agentId));
  }
  const [row] = await db
    .select({
      total: sumAsNumber(costEvents.costCents),
    })
    .from(costEvents)
    .where(and(...conditions));
  return Number(row?.total ?? 0);
}

export function costService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  const budgets = budgetService(db, budgetHooks);
  return {
    createEvent: async (companyId: string, data: Omit<typeof costEvents.$inferInsert, "companyId">) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, data.agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent) throw notFound("Agent not found");
      if (agent.companyId !== companyId) {
        throw unprocessable("Agent does not belong to company");
      }

      const event = await db
        .insert(costEvents)
        .values({
          ...data,
          companyId,
          biller: data.biller ?? data.provider,
          billingType: data.billingType ?? "unknown",
          cachedInputTokens: data.cachedInputTokens ?? 0,
        })
        .returning()
        .then((rows) => rows[0]);

      const [agentMonthSpend, companyMonthSpend] = await Promise.all([
        getMonthlySpendTotal(db, { companyId, agentId: event.agentId }),
        getMonthlySpendTotal(db, { companyId }),
      ]);

      await db
        .update(agents)
        .set({
          spentMonthlyCents: agentMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, event.agentId));

      await db
        .update(companies)
        .set({
          spentMonthlyCents: companyMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));

      await budgets.evaluateCostEvent(event);

      return event;
    },

    summary: async (companyId: string, range?: CostDateRange) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const [{ total }] = await db
        .select({
          total: sumAsNumber(costEvents.costCents),
        })
        .from(costEvents)
        .where(and(...conditions));

      const spendCents = Number(total);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (spendCents / company.budgetMonthlyCents) * 100
          : 0;

      return {
        companyId,
        spendCents,
        budgetCents: company.budgetMonthlyCents,
        utilizationPercent: Number(utilization.toFixed(2)),
      };
    },

    issueTreeSummary: async (
      companyId: string,
      issueId: string,
      options: { excludeRoot?: boolean } = {},
    ) => {
      // Callers must resolve and authorize a visible root issue before invoking this.
      // The route does that so zero counts are not mistaken for a missing root.
      const childIssues = alias(issues, "child");

      // The seed of the recursive CTE: when excludeRoot is true, start from
      // the direct children so the root issue itself is not counted.
      const cteSeed = options.excludeRoot
        ? sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `
        : sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `;

      const cteSeedText = options.excludeRoot
        ? sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `
        : sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `;

      const issueTreeCondition = sql<boolean>`
        ${issues.id} IN (
          WITH RECURSIVE issue_tree(id) AS (
            ${cteSeed}
            UNION ALL
            SELECT ${childIssues.id}
            FROM ${issues} ${childIssues}
            JOIN issue_tree ON ${childIssues.parentId} = issue_tree.id
            WHERE ${childIssues.companyId} = ${companyId}
              AND ${childIssues.hiddenAt} IS NULL
              AND ${childIssues.harnessKind} IS NULL
          )
          SELECT id FROM issue_tree
        )
      `;

      const runSummarySql = sql`
        WITH RECURSIVE issue_tree(id) AS (
          ${cteSeedText}
          UNION ALL
          SELECT (${childIssues.id})::text
          FROM ${issues} ${childIssues}
          JOIN issue_tree ON (${childIssues.parentId})::text = issue_tree.id
          WHERE ${childIssues.companyId} = ${companyId}
            AND ${childIssues.hiddenAt} IS NULL
            AND ${childIssues.harnessKind} IS NULL
        )
        SELECT
          count(distinct ${heartbeatRuns.id})::int AS "runCount",
          coalesce(sum(extract(epoch from (coalesce(${heartbeatRuns.finishedAt}, now()) - ${heartbeatRuns.startedAt})) * 1000), 0)::double precision AS "runtimeMs"
        FROM ${heartbeatRuns}
        WHERE ${heartbeatRuns.companyId} = ${companyId}
          AND ${heartbeatRuns.startedAt} IS NOT NULL
          AND (
            ${heartbeatRuns.contextSnapshot} ->> 'issueId' IN (SELECT id FROM issue_tree)
            OR EXISTS (
              SELECT 1
              FROM ${activityLog}
              JOIN issue_tree ON ${activityLog.entityId} = issue_tree.id
              WHERE ${activityLog.companyId} = ${companyId}
                AND ${activityLog.entityType} = 'issue'
                AND ${activityLog.runId} = ${heartbeatRuns.id}
            )
          )
      `;

      // Run cost-event aggregation and run-duration aggregation in parallel.
      // They're separate queries because cost_events fan out per-event and
      // joining heartbeat_runs through them would double-count run durations.
      const [costRowResult, runRowResult] = await Promise.all([
        db
          .select({
            issueCount: sql<number>`count(distinct ${issues.id})::int`,
            costCents: sumAsNumber(costEvents.costCents),
            inputTokens: sumAsNumber(costEvents.inputTokens),
            cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
            outputTokens: sumAsNumber(costEvents.outputTokens),
          })
          .from(issues)
          .leftJoin(
            costEvents,
            and(
              eq(costEvents.companyId, companyId),
              eq(costEvents.issueId, issues.id),
            ),
          )
          .where(
            and(
              eq(issues.companyId, companyId),
              visibleIssueCondition(),
              issueTreeCondition,
            ),
          ),
        db.execute(runSummarySql),
      ]);

      const costRow = costRowResult[0];
      const runRow = Array.isArray(runRowResult)
        ? (runRowResult[0] as { runCount?: number | string | null; runtimeMs?: number | string | null } | undefined)
        : undefined;

      return {
        issueId,
        issueCount: Number(costRow?.issueCount ?? 0),
        includeDescendants: true,
        costCents: Number(costRow?.costCents ?? 0),
        inputTokens: Number(costRow?.inputTokens ?? 0),
        cachedInputTokens: Number(costRow?.cachedInputTokens ?? 0),
        outputTokens: Number(costRow?.outputTokens ?? 0),
        runCount: Number(runRow?.runCount ?? 0),
        runtimeMs: Number(runRow?.runtimeMs ?? 0),
      };
    },

    byAgent: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(costEvents.agentId, agents.name, agents.status)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    byProvider: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    byBiller: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          biller: costEvents.biller,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
          providerCount: sql<number>`count(distinct ${costEvents.provider})::int`,
          modelCount: sql<number>`count(distinct ${costEvents.model})::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.biller)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    /**
     * aggregates cost_events by provider for each of three rolling windows:
     * last 5 hours, last 24 hours, last 7 days.
     * purely internal consumption data, no external rate-limit sources.
     */
    windowSpend: async (companyId: string) => {
      const windows = [
        { label: "5h", hours: 5 },
        { label: "24h", hours: 24 },
        { label: "7d", hours: 168 },
      ] as const;

      const results = await Promise.all(
        windows.map(async ({ label, hours }) => {
          const since = new Date(Date.now() - hours * 60 * 60 * 1000);
          const rows = await db
            .select({
              provider: costEvents.provider,
              biller: sql<string>`case when count(distinct ${costEvents.biller}) = 1 then min(${costEvents.biller}) else 'mixed' end`,
              costCents: sumAsNumber(costEvents.costCents),
              inputTokens: sumAsNumber(costEvents.inputTokens),
              cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
              outputTokens: sumAsNumber(costEvents.outputTokens),
            })
            .from(costEvents)
            .where(
              and(
                eq(costEvents.companyId, companyId),
                gte(costEvents.occurredAt, since),
              ),
            )
            .groupBy(costEvents.provider)
            .orderBy(desc(sumAsNumber(costEvents.costCents)));

          return rows.map((row) => ({
            provider: row.provider,
            biller: row.biller,
            window: label as string,
            windowHours: hours,
            costCents: row.costCents,
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            outputTokens: row.outputTokens,
          }));
        }),
      );

      return results.flat();
    },

    byAgentModel: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      // single query: group by agent + provider + model.
      // the (companyId, agentId, occurredAt) composite index covers this well.
      // order by provider + model for stable db-level ordering; cost-desc sort
      // within each agent's sub-rows is done client-side in the ui memo.
      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(
          costEvents.agentId,
          agents.name,
          costEvents.provider,
          costEvents.biller,
          costEvents.billingType,
          costEvents.model,
        )
        .orderBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model);
    },

    byProject: async (companyId: string, range?: CostDateRange) => {
      const issueIdAsText = sql<string>`${issues.id}::text`;
      const runProjectLinks = db
        .selectDistinctOn([activityLog.runId, issues.projectId], {
          runId: activityLog.runId,
          projectId: issues.projectId,
        })
        .from(activityLog)
        .innerJoin(
          issues,
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(issues.companyId, companyId),
            isNotNull(activityLog.runId),
            isNotNull(issues.projectId),
          ),
        )
        .orderBy(activityLog.runId, issues.projectId, desc(activityLog.createdAt))
        .as("run_project_links");

      const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, ${runProjectLinks.projectId})`;
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costCentsExpr = sumAsNumber(costEvents.costCents);

      return db
        .select({
          projectId: effectiveProjectId,
          projectName: projects.name,
          costCents: costCentsExpr,
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(runProjectLinks, eq(costEvents.heartbeatRunId, runProjectLinks.runId))
        .innerJoin(projects, sql`${projects.id} = ${effectiveProjectId}`)
        .where(and(...conditions, sql`${effectiveProjectId} is not null`))
        .groupBy(effectiveProjectId, projects.name)
        .orderBy(desc(costCentsExpr));
    },

    /**
     * Cloud-internal, all-companies read backing GET /api/cloud/activation-signals
     * (the control-plane's lifecycle-email sweep). Field-definition judgment
     * calls, since none of these are single dedicated columns in the schema:
     *
     * - hasAgent: any live (non-terminated) agent row WITHOUT the built-in
     *   marker set by services/built-in-agent-metadata.ts. Every company gets
     *   a platform-seeded built-in agent, so counting that would make every
     *   company look "activated" on day one; hasAgent specifically means "the
     *   company hired someone".
     * - agentCount: a plain headcount of live (non-terminated) agents,
     *   INCLUDING built-ins - this is a raw metric, not a gating boolean, so
     *   it intentionally does not share hasAgent's exclusion.
     * - hasCompletedRun / monthRunCount: heartbeat_runs.status = 'succeeded'
     *   (the literal terminal-success value; see HEARTBEAT_RUN_STATUSES in
     *   @paperclipai/shared and setRunStatus() in services/heartbeat.ts).
     *   There is a purpose-built activation_events table
     *   (services/activation.ts) that records "first successful run", but
     *   it's only populated when PAPERCLIP_ACTIVATION_SINK=db is set in the
     *   deployment env; querying heartbeat_runs directly avoids silently
     *   under-reporting in any environment that hasn't set that flag.
     * - lastActivityAt: max(heartbeat_runs.updated_at) across ALL runs
     *   (not just succeeded ones) - setRunStatus() touches updated_at on
     *   every status transition, so it's a reliable "last agent activity"
     *   timestamp regardless of outcome.
     * - hasCredential: any company_secrets row (the general connected
     *   secret/API-key store) with status = 'active' and deleted_at IS NULL,
     *   scoped by companyId. company_secrets is scoped to the company (agent-
     *   level secrets are expressed via company_secret_bindings, not a
     *   separate agentId column), which matches the brief's "scoped to the
     *   company or its agents" - every agent-scoped secret is still a
     *   company_secrets row with this company's companyId.
     * - monthRunCount / monthCostCents: current UTC calendar month, matching
     *   currentUtcMonthWindow()/getMonthlySpendTotal() above. monthRunCount
     *   counts succeeded runs whose updated_at falls in the window (same
     *   basis as lastActivityAt); monthCostCents sums cost_events.cost_cents
     *   whose occurred_at falls in the window (the same column
     *   getMonthlySpendTotal uses for a single company).
     * - firstSucceededAt: min(heartbeat_runs.updated_at) over succeeded runs,
     *   as an ISO string. Same "query heartbeat_runs, not activation_events"
     *   reasoning as hasCompletedRun: activation_events only exists when
     *   PAPERCLIP_ACTIVATION_SINK=db is set, and updated_at is the terminal-
     *   transition timestamp setRunStatus() stamps, so its min over succeeded
     *   runs IS the first success. Serialized to ISO here (not left as a
     *   Date like lastActivityAt) so the wire shape is explicit rather than
     *   an accident of res.json's Date serialization.
     * - weekRunsSucceeded / weekRunsFailed: trailing 7 x 24h window ending at
     *   query time (now - 7d), NOT a calendar week - the control-plane's
     *   pull-back sweep runs daily, so a rolling window gives it a stable
     *   "how did the last week actually go" ratio without day-of-week cliffs.
     *   Succeeded = status 'succeeded'; failed = status IN ('failed',
     *   'timed_out', 'error'). 'failed' and 'timed_out' are the two terminal
     *   failure values in HEARTBEAT_RUN_STATUSES; 'error' is not in that
     *   list today but is matched defensively so a historical or future
     *   error-status row still counts as a failure signal. 'interrupted' and
     *   'cancelled' are deliberately excluded: a user stopping a run is not
     *   a product failure worth a pull-back email.
     * - pendingApprovalCount / pendingApprovals: approvals rows with
     *   status = 'pending'. The count covers ALL pending approvals; the
     *   detail list is capped to the 5 OLDEST (created_at asc, id as
     *   tie-break) because the email only needs a few concrete examples and
     *   the oldest ones are the ones actually blocking the company.
     *   agentName resolves requested_by_agent_id -> agents.name and is null
     *   for user-requested approvals (requested_by_agent_id IS NULL). Both
     *   derive from ONE ordered scan of pending approvals, counted and
     *   capped in JS during the merge below - pending approvals are rare and
     *   short-lived (they block work), so the scan stays small and we avoid
     *   a window-function subquery just to cap at 5.
     *
     * Companies whose signals are entirely false/zero are omitted - the
     * control-plane treats absence as all-false/zero (see the route comment).
     * A pending approval or a recent failed run IS a signal: a company whose
     * only sign of life is a stuck approval or a failing week must still
     * appear, since those are exactly the companies the pull-back sweep
     * wants to email.
     */
    listActivationSignals: async (): Promise<ActivationSignalsRow[]> => {
      const { start, end } = currentUtcMonthWindow();
      // Embedding a raw JS Date inside a `sql` template (as opposed to going
      // through drizzle's gte()/lt() column-aware helpers) skips the driver's
      // timestamptz encoding and postgres-js's binary Bind step rejects the
      // Date instance outright; pass ISO strings instead, which postgres
      // parses fine for timestamptz comparisons.
      const startIso = start.toISOString();
      const endIso = end.toISOString();
      const weekStartIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [agentRows, runRows, credentialRows, costRows, pendingApprovalRows] = await Promise.all([
        db
          .select({
            companyId: agents.companyId,
            agentCount: sql<number>`count(*) filter (where ${agents.status} != 'terminated')::int`,
            hasAgent: sql<boolean>`bool_or(
              ${agents.status} != 'terminated'
              and (${agents.metadata} -> ${BUILT_IN_AGENT_METADATA_KEY}) is null
            )`,
          })
          .from(agents)
          .groupBy(agents.companyId),
        db
          .select({
            companyId: heartbeatRuns.companyId,
            hasCompletedRun: sql<boolean>`bool_or(${heartbeatRuns.status} = 'succeeded')`,
            lastActivityAt: sql<Date | null>`max(${heartbeatRuns.updatedAt})`,
            monthRunCount: sql<number>`count(*) filter (
              where ${heartbeatRuns.status} = 'succeeded'
              and ${heartbeatRuns.updatedAt} >= ${startIso}
              and ${heartbeatRuns.updatedAt} < ${endIso}
            )::int`,
            firstSucceededAt: sql<Date | null>`min(${heartbeatRuns.updatedAt}) filter (where ${heartbeatRuns.status} = 'succeeded')`,
            weekRunsSucceeded: sql<number>`count(*) filter (
              where ${heartbeatRuns.status} = 'succeeded'
              and ${heartbeatRuns.updatedAt} >= ${weekStartIso}
            )::int`,
            weekRunsFailed: sql<number>`count(*) filter (
              where ${heartbeatRuns.status} in ('failed', 'timed_out', 'error')
              and ${heartbeatRuns.updatedAt} >= ${weekStartIso}
            )::int`,
          })
          .from(heartbeatRuns)
          .groupBy(heartbeatRuns.companyId),
        db
          .select({
            companyId: companySecrets.companyId,
            hasCredential: sql<boolean>`bool_or(${companySecrets.status} = 'active' and ${companySecrets.deletedAt} is null)`,
          })
          .from(companySecrets)
          .groupBy(companySecrets.companyId),
        db
          .select({
            companyId: costEvents.companyId,
            monthCostCents: sql<number>`coalesce(sum(${costEvents.costCents}) filter (
              where ${costEvents.occurredAt} >= ${startIso} and ${costEvents.occurredAt} < ${endIso}
            ), 0)::int`,
          })
          .from(costEvents)
          .groupBy(costEvents.companyId),
        db
          .select({
            companyId: approvals.companyId,
            id: approvals.id,
            type: approvals.type,
            agentName: agents.name,
            createdAt: approvals.createdAt,
          })
          .from(approvals)
          .leftJoin(agents, eq(approvals.requestedByAgentId, agents.id))
          .where(eq(approvals.status, "pending"))
          .orderBy(asc(approvals.createdAt), asc(approvals.id)),
      ]);

      const byCompany = new Map<string, ActivationSignalsRow>();
      const rowFor = (companyId: string) => {
        let row = byCompany.get(companyId);
        if (!row) {
          row = {
            companyId,
            hasAgent: false,
            hasCompletedRun: false,
            hasCredential: false,
            agentCount: 0,
            lastActivityAt: null,
            monthRunCount: 0,
            monthCostCents: 0,
            firstSucceededAt: null,
            weekRunsSucceeded: 0,
            weekRunsFailed: 0,
            pendingApprovalCount: 0,
            pendingApprovals: [],
          };
          byCompany.set(companyId, row);
        }
        return row;
      };

      for (const r of agentRows) {
        const row = rowFor(r.companyId);
        row.agentCount = Number(r.agentCount ?? 0);
        row.hasAgent = Boolean(r.hasAgent);
      }
      for (const r of runRows) {
        const row = rowFor(r.companyId);
        row.hasCompletedRun = Boolean(r.hasCompletedRun);
        row.lastActivityAt = r.lastActivityAt ? new Date(r.lastActivityAt) : null;
        row.monthRunCount = Number(r.monthRunCount ?? 0);
        row.firstSucceededAt = r.firstSucceededAt ? new Date(r.firstSucceededAt).toISOString() : null;
        row.weekRunsSucceeded = Number(r.weekRunsSucceeded ?? 0);
        row.weekRunsFailed = Number(r.weekRunsFailed ?? 0);
      }
      for (const r of credentialRows) {
        rowFor(r.companyId).hasCredential = Boolean(r.hasCredential);
      }
      for (const r of costRows) {
        rowFor(r.companyId).monthCostCents = Number(r.monthCostCents ?? 0);
      }
      // pendingApprovalRows arrive ordered oldest-first (created_at asc, id
      // tie-break), so counting every row while pushing only the first 5 per
      // company yields both the full count and the capped oldest-5 detail
      // list in a single pass.
      for (const r of pendingApprovalRows) {
        const row = rowFor(r.companyId);
        row.pendingApprovalCount += 1;
        if (row.pendingApprovals.length < 5) {
          row.pendingApprovals.push({
            id: r.id,
            type: r.type,
            agentName: r.agentName ?? null,
            createdAt: new Date(r.createdAt).toISOString(),
          });
        }
      }

      return Array.from(byCompany.values()).filter(
        (row) =>
          row.hasAgent ||
          row.hasCompletedRun ||
          row.hasCredential ||
          row.agentCount > 0 ||
          row.monthRunCount > 0 ||
          row.monthCostCents > 0 ||
          row.weekRunsFailed > 0 ||
          row.pendingApprovalCount > 0,
      );
    },
  };
}
