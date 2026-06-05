import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, eq } from "drizzle-orm";
import { createDb, authUsers, instanceUserRoles } from "@paperclipai/db";
import { loadPaperclipEnvFile } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";

const DEFAULT_SEED_ADMIN_USER_ID = "platform-admin";
const DEFAULT_SEED_ADMIN_EMAIL = "platform-admin@paperclip.inc";
const DEFAULT_SEED_ADMIN_NAME = "Paperclip Platform";

const INSTANCE_ADMIN_ROLE = "instance_admin";

export interface SeedInstanceAdminPrincipal {
  userId: string;
  email: string;
  name: string;
}

export interface EnsureInstanceAdminResult {
  /** True when a brand new authUsers row was inserted. */
  createdUser: boolean;
  /** True when a brand new instance_admin role row was inserted. */
  createdRole: boolean;
}

function resolveDbUrl(configPath?: string, explicitDbUrl?: string): string | null {
  if (explicitDbUrl) return explicitDbUrl;
  const config = readConfig(configPath);
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (config?.database.mode === "postgres" && config.database.connectionString) {
    return config.database.connectionString;
  }
  if (config?.database.mode === "embedded-postgres") {
    const port = config.database.embeddedPostgresPort ?? 54329;
    return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  }
  return null;
}

/**
 * Resolve the seed principal from environment variables, applying the
 * platform defaults defined by the operator init-container contract.
 */
export function resolveSeedPrincipal(
  env: NodeJS.ProcessEnv = process.env,
): SeedInstanceAdminPrincipal {
  const userId = env.PAPERCLIP_SEED_ADMIN_USER_ID?.trim() || DEFAULT_SEED_ADMIN_USER_ID;
  const email = env.PAPERCLIP_SEED_ADMIN_EMAIL?.trim() || DEFAULT_SEED_ADMIN_EMAIL;
  const name = env.PAPERCLIP_SEED_ADMIN_NAME?.trim() || DEFAULT_SEED_ADMIN_NAME;
  return { userId, email, name };
}

/**
 * Idempotently ensure that an authUsers row and an instance_admin
 * instanceUserRoles row exist for the given principal.
 *
 * Mirrors the upsert pattern in server/src/index.ts:ensureLocalTrustedBoardPrincipal.
 * Safe to run repeatedly (e.g. on every boot of a shared/cloud deployment):
 * running it twice yields exactly one instance_admin row for the principal.
 *
 * Does NOT create company memberships: instance_admin bypasses company
 * scoping via authz, so no membership rows are required.
 */
export async function ensureInstanceAdmin(
  db: {
    select: (...args: any[]) => any;
    insert: (...args: any[]) => any;
  },
  principal: SeedInstanceAdminPrincipal,
): Promise<EnsureInstanceAdminResult> {
  const now = new Date();

  const existingUser = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, principal.userId))
    .then((rows: Array<{ id: string }>) => rows[0] ?? null);

  let createdUser = false;
  if (!existingUser) {
    await db.insert(authUsers).values({
      id: principal.userId,
      name: principal.name,
      email: principal.email,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    createdUser = true;
  }

  const existingRole = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(
      and(
        eq(instanceUserRoles.userId, principal.userId),
        eq(instanceUserRoles.role, INSTANCE_ADMIN_ROLE),
      ),
    )
    .then((rows: Array<{ id: string }>) => rows[0] ?? null);

  let createdRole = false;
  if (!existingRole) {
    await db.insert(instanceUserRoles).values({
      userId: principal.userId,
      role: INSTANCE_ADMIN_ROLE,
    });
    createdRole = true;
  }

  return { createdUser, createdRole };
}

export async function seedInstanceAdmin(opts: {
  config?: string;
  dbUrl?: string;
}): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);

  const principal = resolveSeedPrincipal();

  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error(
      `Could not resolve database connection. Set ${pc.cyan("DATABASE_URL")} or pass ${pc.cyan("--db-url")}.`,
    );
    process.exitCode = 1;
    return;
  }

  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: {
      end?: (options?: { timeout?: number }) => Promise<void>;
    };
  };
  try {
    const result = await ensureInstanceAdmin(db, principal);

    if (result.createdRole) {
      p.log.success(
        `Seeded instance admin ${pc.cyan(principal.userId)} (${pc.dim(principal.email)}).`,
      );
    } else {
      p.log.info(
        `Instance admin ${pc.cyan(principal.userId)} already present. No changes made.`,
      );
    }
  } catch (err) {
    p.log.error(
      `Could not seed instance admin: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
