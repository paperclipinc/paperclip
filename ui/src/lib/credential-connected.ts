import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";
import type { CompanySecret } from "@paperclipai/shared";

export type SessionBinding = { type: "secret_ref"; secretId: string };

function toKebab(value: string): string {
  return value.toLowerCase().replace(/_/g, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mirrors the secret naming in AdapterCredentialConnect.tsx:151.
 */
export function credentialSecretName(adapterType: string, envKey: string): string {
  return `${toKebab(adapterType)}-${toKebab(envKey)}`;
}

/**
 * A credential counts as connected only when the CURRENT company actually has a
 * usable secret for one of this adapter's env keys, or the user just bound one
 * in this session. Session bindings are deliberately NOT persisted: localStorage
 * is per origin, so a restored binding can name another company's secret, which
 * the server rejects with "Secret must belong to same company".
 *
 * Secret keys are free text a user can name anything, so the match against the
 * canonical `credentialSecretName` base must be exact or the client's own
 * collision-suffix scheme (`-2`, `-3`, ...), never a loose prefix. A prefix
 * match would let an unrelated active secret like
 * `claude-local-anthropic-api-key-backup-notes` falsely count as connected.
 */
export function deriveCredentialConnected(
  setup: AdapterCredentialSetup | undefined,
  secrets: CompanySecret[] | undefined,
  sessionBindings: Record<string, SessionBinding>,
  adapterType: string,
): boolean {
  const envKeys = (setup?.options ?? []).map((o) => o.envKey);
  if (envKeys.length === 0) return false;

  if (envKeys.some((k) => Boolean(sessionBindings[k]))) return true;

  const usable = (secrets ?? []).filter((s) => s.status === "active" && !s.deletedAt);
  return envKeys.some((envKey) => {
    const base = credentialSecretName(adapterType, envKey);
    // Exact match, or the client's numeric collision-suffix scheme (-2, -3, ...).
    const pattern = new RegExp(`^${escapeRegExp(base)}(-\\d+)?$`);
    return usable.some((s) => pattern.test(s.key));
  });
}
