import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activationEvents } from "@paperclipai/db";

export type ActivationSink = "db";

export interface ActivationStore {
  countActivationForCompany(companyId: string): Promise<number>;
  insertActivationEvent(row: {
    companyId: string;
    agentId: string;
    heartbeatRunId: string | null;
    eventType: string;
    firstForCompany: boolean;
    occurredAt: Date;
  }): Promise<void>;
}

export function resolveActivationSink(
  env: Record<string, string | undefined> = process.env,
): ActivationSink | null {
  return env.PAPERCLIP_ACTIVATION_SINK === "db" ? "db" : null;
}

/**
 * The only run status that may produce an activation event. The row this
 * module writes is `first_successful_run`, and every consumer reads it as
 * proof the customer got a working run: the admin console derives the
 * "Activated" milestone from MIN(occurred_at) with no join back to the run,
 * and the lifecycle/outreach rules treat activation as the aha moment.
 * Anything short of a completed run must therefore not count, however many
 * tokens it burned on the way to failing.
 */
const ACTIVATING_RUN_STATUS = "succeeded";

export async function recordActivationEvent(
  store: ActivationStore,
  args: {
    companyId: string;
    agentId: string;
    heartbeatRunId: string | null;
    sink: ActivationSink | null;
    /**
     * Terminal status of the run being recorded. Required, and deliberately
     * not defaulted: the caller sits on the cost-event path, which fires for
     * any run with token usage including failed ones, so an omitted status
     * must fail closed rather than silently activate.
     */
    runStatus: string | null | undefined;
    occurredAt?: Date;
  },
): Promise<void> {
  if (!args.sink) return;
  if (args.runStatus !== ACTIVATING_RUN_STATUS) return;
  try {
    const prior = await store.countActivationForCompany(args.companyId);
    await store.insertActivationEvent({
      companyId: args.companyId,
      agentId: args.agentId,
      heartbeatRunId: args.heartbeatRunId,
      eventType: "first_successful_run",
      firstForCompany: prior === 0,
      occurredAt: args.occurredAt ?? new Date(),
    });
  } catch {
    // Instrumentation must never break a run. Swallow and move on.
  }
}

export function createDrizzleActivationStore(db: Db): ActivationStore {
  return {
    async countActivationForCompany(companyId) {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(activationEvents)
        .where(eq(activationEvents.companyId, companyId));
      return rows[0]?.n ?? 0;
    },
    async insertActivationEvent(row) {
      await db.insert(activationEvents).values({
        companyId: row.companyId,
        agentId: row.agentId,
        heartbeatRunId: row.heartbeatRunId,
        eventType: row.eventType,
        firstForCompany: row.firstForCompany,
        occurredAt: row.occurredAt,
      });
    },
  };
}

export async function hasActivationForCompany(
  store: ActivationStore,
  companyId: string,
): Promise<boolean> {
  return (await store.countActivationForCompany(companyId)) > 0;
}
