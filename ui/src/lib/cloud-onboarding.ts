/**
 * First-run onboarding tracking for cloud_tenant mode.
 *
 * In cloud_tenant mode (health.deploymentMode === "authenticated") the company
 * is auto-created on first request, so the single-tenant "you have no companies,
 * onboard" trigger never fires. Instead we surface the wizard exactly once per
 * company the first time the user lands, and remember completion in
 * localStorage so it never reopens. The Company step renames the existing
 * company rather than creating a new one.
 */

const STORAGE_PREFIX = "paperclip.cloud.onboarded.";

function storageKey(companyId: string): string {
  return `${STORAGE_PREFIX}${companyId}`;
}

/**
 * Whether the cloud first-run onboarding wizard has already been completed (or
 * dismissed) for this company. Treats an unavailable/throwing localStorage as
 * "already onboarded" so we never trap the user in a wizard we can't dismiss.
 */
export function hasCompletedCloudOnboarding(companyId: string): boolean {
  if (!companyId) return true;
  try {
    return window.localStorage.getItem(storageKey(companyId)) !== null;
  } catch {
    return true;
  }
}

/** Mark the cloud first-run onboarding wizard complete for this company. */
export function markCloudOnboardingComplete(companyId: string): void {
  if (!companyId) return;
  try {
    window.localStorage.setItem(storageKey(companyId), new Date().toISOString());
  } catch {
    // Best-effort: if storage is unavailable the worst case is the wizard
    // re-opens next load, which is preferable to throwing during onboarding.
  }
}

/**
 * Whether the cloud first-run onboarding wizard should auto-open: only in cloud
 * (authenticated) mode, only once a single company exists, and only if it has
 * not already been completed for that company.
 */
export function shouldOpenCloudOnboarding(params: {
  deploymentMode?: string;
  companyId?: string | null;
}): boolean {
  const { deploymentMode, companyId } = params;
  if (deploymentMode !== "authenticated") return false;
  if (!companyId) return false;
  return !hasCompletedCloudOnboarding(companyId);
}
