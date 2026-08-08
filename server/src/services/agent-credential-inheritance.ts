import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Merge a donor agent's credential env bindings into a new agent's requested env,
 * so newly created/provisioned agents inherit the company's working credential.
 * Only `secret_ref` bindings are inherited (the shape the credential-connect flow
 * produces), any env key the request already set is left untouched, and the donor
 * binding's projection semantics are preserved verbatim. Pure/testable.
 */
export function mergeInheritedCredentialEnv(
  donorEnv: Record<string, unknown>,
  requestedEnv: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...requestedEnv };
  for (const [envKey, binding] of Object.entries(donorEnv)) {
    const parsed = asRecord(binding);
    if (!parsed || parsed.type !== "secret_ref" || typeof parsed.secretId !== "string") continue;
    if (Object.prototype.hasOwnProperty.call(requestedEnv, envKey)) continue;
    const inherited: Record<string, unknown> = {
      type: "secret_ref",
      secretId: parsed.secretId,
      version: parsed.version ?? "latest",
    };
    if (typeof parsed.projectionClass === "string") inherited.projectionClass = parsed.projectionClass;
    if (parsed.projectionAllowlistKey !== undefined) inherited.projectionAllowlistKey = parsed.projectionAllowlistKey;
    merged[envKey] = inherited;
  }
  return merged;
}

/** True when an agent's adapterConfig already carries a credential binding. */
export function adapterConfigHasSecretRef(adapterConfig: unknown): boolean {
  const env = asRecord(asRecord(adapterConfig)?.env);
  if (!env) return false;
  return Object.values(env).some((binding) => {
    const parsed = asRecord(binding);
    return parsed?.type === "secret_ref" && typeof parsed.secretId === "string";
  });
}

/**
 * Decide which of a company's same-adapter agents should receive the company
 * credential, given every such agent's current row. Pure, so the rule is
 * testable without a database.
 *
 * The create-time path ({@link inheritCompanyCredentialEnv}) only ever fires
 * while an agent is being made, which is the wrong moment for the common case:
 * a company and its built-in agents exist from signup and the user connects a
 * provider key afterwards. Nothing re-ran inheritance, so those agents stayed
 * credential-less permanently and a factory-config built-in agent could never
 * run. This closes that gap by re-running the same donor rule over agents that
 * already exist.
 *
 * Same donor preference as create time (a CEO with a credential, else any agent
 * with one) and the same merge semantics, so an agent that already has its own
 * credential is never touched and a second pass is a no-op.
 */
export function planCompanyCredentialBackfill(
  rows: Array<{ id: string; role: string | null; adapterConfig: unknown }>,
): Array<{ agentId: string; adapterConfig: Record<string, unknown> }> {
  const donors = rows.filter((row) => adapterConfigHasSecretRef(row.adapterConfig));
  const donor = donors.find((row) => row.role === "ceo") ?? donors[0];
  if (!donor) return [];
  const donorEnv = asRecord(asRecord(donor.adapterConfig)?.env) ?? {};
  const writes: Array<{ agentId: string; adapterConfig: Record<string, unknown> }> = [];
  for (const row of rows) {
    if (adapterConfigHasSecretRef(row.adapterConfig)) continue;
    const config = asRecord(row.adapterConfig) ?? {};
    const env = mergeInheritedCredentialEnv(donorEnv, asRecord(config.env) ?? {});
    if (Object.keys(env).length === 0) continue;
    writes.push({ agentId: row.id, adapterConfig: { ...config, env } });
  }
  return writes;
}

/**
 * Apply {@link planCompanyCredentialBackfill} to every agent of one adapter
 * type in a company. `update` is injected rather than imported so this stays
 * free of the agent service (which owns secret-binding sync) and free of a
 * dependency cycle. Returns the ids actually written.
 */
export async function backfillCompanyCredentialEnv(
  db: Db,
  companyId: string,
  adapterType: string,
  update: (agentId: string, adapterConfig: Record<string, unknown>) => Promise<unknown>,
): Promise<string[]> {
  let rows: Array<{ id: string; role: string | null; adapterConfig: unknown }>;
  try {
    rows = await db
      .select({ id: agents.id, role: agents.role, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.adapterType, adapterType)));
  } catch {
    return [];
  }
  const written: string[] = [];
  for (const write of planCompanyCredentialBackfill(rows)) {
    // One agent failing to update must not strand the rest: this runs as a
    // side effect of a request that has already succeeded.
    try {
      await update(write.agentId, write.adapterConfig);
      written.push(write.agentId);
    } catch {
      // keep going
    }
  }
  return written;
}

// Inherit the company's credential env bindings onto a newly created/provisioned
// agent so it can authenticate without the user re-connecting a key for every
// agent. Copies each `secret_ref` env binding from an existing same-adapter
// company agent (preferring the CEO) into the new agent's `adapterConfig.env`,
// never overriding an env the request set explicitly. No-op when no donor agent
// of the same adapterType has a credential (no behavior change / no regression).
export async function inheritCompanyCredentialEnv(
  db: Db,
  companyId: string,
  adapterType: string,
  requestedAdapterConfig: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestedEnv = asRecord(requestedAdapterConfig.env) ?? {};
  let donorRows: Array<{ role: string | null; adapterConfig: unknown }>;
  try {
    donorRows = await db
      .select({ role: agents.role, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.adapterType, adapterType)));
  } catch {
    return requestedAdapterConfig;
  }
  // A donor must have at least one secret_ref binding: an agent whose env is
  // empty (or holds only plain/cleared values) would otherwise win the ceo
  // preference and make inheritance a silent no-op.
  const donors = donorRows.filter((row) => {
    const env = asRecord(asRecord(row.adapterConfig)?.env);
    if (!env) return false;
    return Object.values(env).some((binding) => {
      const parsed = asRecord(binding);
      return parsed?.type === "secret_ref" && typeof parsed.secretId === "string";
    });
  });
  const donor = donors.find((row) => row.role === "ceo") ?? donors[0];
  if (!donor) return requestedAdapterConfig;
  const donorEnv = asRecord(asRecord(donor.adapterConfig)?.env) ?? {};
  return { ...requestedAdapterConfig, env: mergeInheritedCredentialEnv(donorEnv, requestedEnv) };
}
