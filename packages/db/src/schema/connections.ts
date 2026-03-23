import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    status: text("status").notNull().default("active"),
    scopes: jsonb("scopes").notNull().default([]),
    secretId: uuid("secret_id").references(() => companySecrets.id, {
      onDelete: "set null",
    }),
    accountLabel: text("account_label"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("connections_company_idx").on(table.companyId),
    statusIdx: index("connections_status_idx").on(table.status),
    companyProviderUq: uniqueIndex("connections_company_provider_uq").on(
      table.companyId,
      table.providerId,
    ),
  }),
);
