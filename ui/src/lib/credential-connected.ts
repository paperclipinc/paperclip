import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestResult, CompanySecret } from "@paperclipai/shared";

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
 * ANTHROPIC_API_KEY (and other envKey names) are not globally unique to one
 * adapter — claude_local, opencode_local, and pi_local each advertise it
 * (see packages/adapters/*\/src/ui/credential-setup.ts). A rejection
 * recorded while onboarding claude_local must not read as a failure for
 * opencode_local's own, independently-bound ANTHROPIC_API_KEY, so failure
 * records are keyed by (adapterType, envKey), not envKey alone.
 */
export function credentialFailureKey(adapterType: string, envKey: string): string {
  return `${adapterType}:${envKey}`;
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
 *
 * @param failedEnvKeys keys built with `credentialFailureKey(adapterType,
 * envKey)` for every (adapter, envKey) pair whose most recent live-probe
 * result came back with the provider explicitly rejecting the credential
 * (see `findCredentialAuthFailureCheck`). Excluded from BOTH the
 * session-binding and the company-secrets checks below: the secret can
 * legitimately still exist server-side in principle (re-pasting the
 * corrected key reuses/suffixes the same name), so its mere presence must
 * not count as "connected" once we know the value it holds was rejected —
 * this is also why the caller disables the secret server-side on
 * rejection, so a stale/failed page reload doesn't fall through to this
 * fallback and re-open the gate on an orphaned active secret. Cleared the
 * moment a fresh bind attempt starts for that (adapter, envKey) pair.
 */
export function deriveCredentialConnected(
  setup: AdapterCredentialSetup | undefined,
  secrets: CompanySecret[] | undefined,
  sessionBindings: Record<string, SessionBinding>,
  adapterType: string,
  failedEnvKeys: ReadonlySet<string> = new Set(),
): boolean {
  const envKeys = (setup?.options ?? [])
    .map((o) => o.envKey)
    .filter((envKey) => !failedEnvKeys.has(credentialFailureKey(adapterType, envKey)));
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

/**
 * Find the check (if any) in a just-run adapter environment test result that
 * represents the PROVIDER explicitly rejecting the credential just bound.
 * The classification itself is server-side (e.g. claude-local's test.ts,
 * which has the actual provider response text); this only reads the typed
 * `authFailure` flag it sets on a hard-fail check, never re-derives
 * pass/fail from raw message text client-side.
 */
export function findCredentialAuthFailureCheck(
  result: AdapterEnvironmentTestResult | null | undefined,
): AdapterEnvironmentCheck | null {
  if (!result) return null;
  return result.checks.find((check) => check.level === "error" && check.authFailure === true) ?? null;
}

/**
 * Plain-language copy for a rejected credential, no em/en dashes. Never
 * surfaces the raw provider/CLI message verbatim (see `check.detail`) —
 * callers that want the original text for support debugging should
 * console.log the check directly rather than render it.
 */
export function credentialRejectionMessage(check: AdapterEnvironmentCheck | null): string | null {
  if (!check) return null;
  return "That key was rejected by the provider. Check it and paste it again.";
}
