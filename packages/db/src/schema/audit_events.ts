import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id"), // nullable — retained even after company deletion
  actorType: text("actor_type").notNull(), // "user", "agent", "system"
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(), // e.g. "company.deleted", "agent.terminated", "secret.rotated"
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
