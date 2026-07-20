/**
 * localStorage is scoped per ORIGIN, not per account, so a browser that already
 * ran onboarding will happily hand a previous company's id to a brand new
 * session. Every downstream call then targets the wrong company: secrets get
 * created there, and the adapter environment check fails with "Secret must
 * belong to same company".
 *
 * So restoring is an authorization decision, not a convenience. If the saved
 * company is not one the signed-in user owns, the whole blob is discarded.
 */
export function restoreOnboardingState(
  raw: unknown,
  companies: Array<{ id: string }>,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const saved = { ...(raw as Record<string, unknown>) };

  // Credential bindings name a secret id. A restored one can belong to another
  // company, and the server rejects it. They are session-only, never persisted.
  delete saved.credentialBindings;

  const companyId = saved.createdCompanyId;
  if (typeof companyId !== "string" || companyId === "") return saved;

  // Companies not loaded yet: refuse rather than guess. The caller retries once
  // the list arrives, so this costs a render, not correctness.
  if (companies.length === 0) return null;

  return companies.some((c) => c.id === companyId) ? saved : null;
}
