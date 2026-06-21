import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const activationEvents = pgTable(
  "activation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id),
    eventType: text("event_type").notNull().default("first_successful_run"),
    firstForCompany: boolean("first_for_company").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    byCompany: index("activation_events_company_idx").on(table.companyId),
    oneFirstPerCompany: uniqueIndex("activation_events_first_per_company_uq")
      .on(table.companyId, table.eventType)
      .where(sql`${table.firstForCompany} = true`),
  }),
);
