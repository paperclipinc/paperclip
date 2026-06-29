// Per-company inference key (Bifrost virtual key) resolver.
//
// In cloud mode the plugin must NOT hand every company's run the single shared
// platform virtual key: that would put all companies' inference traffic in the
// same Bifrost cache bucket / spend ledger, which is a cross-tenant leak. When
// a control-plane URL is configured we resolve each company's OWN virtual key
// here and override the secret auth env vars with it (see plugin.ts).
//
// Behavior is FAIL-CLOSED: a configured-but-failing resolve THROWS so the lease
// is rejected, rather than silently falling back to the shared key.

/**
 * The set of secret inference AUTH env keys whose value the resolved per-company
 * virtual key replaces. These are the keys the harness adapters use to
 * authenticate to the inference gateway. Base URLs and other env are NOT
 * touched — only the auth credential is repartitioned per company.
 */
export const INFERENCE_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
] as const;

// TTL-bounded cache: companyId -> { keyValue, expiresAt }. A control-plane
// round-trip on every lease would be wasteful (leases are frequent, the key is
// usually stable), so we cache. But an UNBOUNDED process-lifetime cache is a
// security hazard: a company vk that is rotated or revoked control-plane-side
// would keep being injected into that company's runs until the worker restarts
// (could be days). A short TTL bounds that staleness window to at most
// `DEFAULT_INFERENCE_KEY_CACHE_TTL_MS`, after which we re-resolve and pick up
// the new key (or fail closed if the key was revoked). Configurable via
// PAPERCLIP_INFERENCE_KEY_CACHE_TTL_MS for ops.
const DEFAULT_INFERENCE_KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function resolveCacheTtlMs(): number {
  const raw = process.env.PAPERCLIP_INFERENCE_KEY_CACHE_TTL_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_INFERENCE_KEY_CACHE_TTL_MS;
}

interface CacheEntry {
  keyValue: string;
  /** epoch ms after which this entry is stale and must be re-resolved. */
  expiresAt: number;
}

const keyCache = new Map<string, CacheEntry>();

/** Test-only: reset the in-process cache between cases. */
export function __resetInferenceKeyCache(): void {
  keyCache.clear();
}

export interface ResolveInferenceKeyOptions {
  resolverUrl: string;
  companyId: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the cache TTL (ms) for this resolve. Injectable for tests. */
  cacheTtlMs?: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Resolve a company's Bifrost virtual key from the cloud control-plane.
 *
 * POSTs `{ companyId }` to `<resolverUrl>/internal/bifrost-key` and expects a
 * 2xx JSON body `{ keyValue: "<vk>" }`. Throws (fail-closed) on any non-2xx
 * status, network error, or missing/empty keyValue. Successful resolves are
 * cached by companyId for the process lifetime.
 */
export async function resolveCompanyInferenceKey(
  opts: ResolveInferenceKeyOptions,
): Promise<string> {
  const { resolverUrl, companyId } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cacheTtlMs = opts.cacheTtlMs ?? resolveCacheTtlMs();

  const cached = keyCache.get(companyId);
  if (cached && cached.expiresAt > now()) return cached.keyValue;
  // Stale (or absent): drop the expired entry and re-resolve below so a rotated
  // or revoked key is picked up rather than served from cache.
  if (cached) keyCache.delete(companyId);

  // Tolerate a trailing slash on the configured URL.
  const endpoint = `${resolverUrl.replace(/\/+$/, "")}/internal/bifrost-key`;

  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId }),
    });
  } catch (err) {
    throw new Error(
      `Failed to resolve per-company inference key for company "${companyId}" from control-plane (${endpoint}): ${
        err instanceof Error ? err.message : String(err)
      }. Refusing to fall back to the shared platform key (cross-tenant cache leak).`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `Control-plane returned ${res.status} resolving the per-company inference key for company "${companyId}" (${endpoint}). Refusing to fall back to the shared platform key (cross-tenant cache leak).`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(
      `Control-plane returned an unparseable body resolving the per-company inference key for company "${companyId}" (${endpoint}): ${
        err instanceof Error ? err.message : String(err)
      }. Refusing to fall back to the shared platform key (cross-tenant cache leak).`,
    );
  }

  const keyValue =
    body && typeof body === "object" && typeof (body as { keyValue?: unknown }).keyValue === "string"
      ? (body as { keyValue: string }).keyValue
      : "";

  if (!keyValue) {
    throw new Error(
      `Control-plane returned no keyValue resolving the per-company inference key for company "${companyId}" (${endpoint}). Refusing to fall back to the shared platform key (cross-tenant cache leak).`,
    );
  }

  keyCache.set(companyId, { keyValue, expiresAt: now() + cacheTtlMs });
  return keyValue;
}

/**
 * Override the secret inference auth env vars in a built adapter env with the
 * resolved per-company virtual key. Only keys that are ALREADY present in the
 * env (i.e. that this adapter actually uses for auth) are overridden — base
 * URLs and any other env are left untouched. Returns a new object; does not
 * mutate the input.
 */
export function applyCompanyInferenceKey(
  adapterEnv: Record<string, string>,
  keyValue: string,
): Record<string, string> {
  const out = { ...adapterEnv };
  for (const k of INFERENCE_AUTH_ENV_KEYS) {
    if (k in out) out[k] = keyValue;
  }
  return out;
}
