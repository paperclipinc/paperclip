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

export async function recordActivationEvent(
  store: ActivationStore,
  args: {
    companyId: string;
    agentId: string;
    heartbeatRunId: string | null;
    sink: ActivationSink | null;
    occurredAt?: Date;
  },
): Promise<void> {
  if (!args.sink) return;
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
