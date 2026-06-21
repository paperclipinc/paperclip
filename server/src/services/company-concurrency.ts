// Per-company concurrent-run ceiling, layered ABOVE the existing per-agent cap.
// Generic + self-host-safe: when the env is unset the cap is null (unbounded) so
// off-cloud behaviour is unchanged. Pure so it unit-tests without a DB.
export function resolveCompanyConcurrencyCap(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.PAPERCLIP_CLOUD_MAX_CONCURRENT_RUNS_PER_COMPANY;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function clampToCompanyConcurrency(args: {
  perAgentSlots: number;
  companyRunningCount: number;
  companyCap: number | null;
}): number {
  const { perAgentSlots, companyRunningCount, companyCap } = args;
  if (companyCap === null) return perAgentSlots;
  const companyRemaining = Math.max(0, companyCap - companyRunningCount);
  return Math.min(perAgentSlots, companyRemaining);
}
