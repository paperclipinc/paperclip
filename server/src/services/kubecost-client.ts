export interface KubecostConfig { baseUrl: string; }
export interface RunWindow { runId: string; namespace: string; start: Date; end: Date; }
// Kubecost's RFC3339 window parser does not want milliseconds; emit
// `2026-06-13T10:00:00Z` rather than `...:00.000Z`.
function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
export async function computeCostUsdForRun(
  cfg: KubecostConfig, run: RunWindow, fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!cfg.baseUrl) return 0;
  const window = `${rfc3339(run.start)},${rfc3339(run.end)}`;
  // Build the query string manually so the colon/slash in `window` and the
  // `paperclip.io/run-id` label survive literally (URLSearchParams would
  // percent-encode them and break Kubecost's parsing + our integration tests).
  const filter = `namespace:"${run.namespace}"+label[paperclip.io/run-id]:"${run.runId}"`;
  const qs = `window=${window}&aggregate=label:paperclip.io/run-id&filter=${filter}&accumulate=true`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/model/allocation?${qs}`, { signal: ac.signal });
    } finally { clearTimeout(timer); }
    if (!res.ok) return 0;
    const body = (await res.json()) as { data?: Array<Record<string, { totalCost?: number }>> };
    const sets = body.data ?? [];
    let total = 0;
    for (const set of sets) { for (const alloc of Object.values(set)) total += Number(alloc?.totalCost ?? 0); }
    return Number.isFinite(total) ? total : 0;
  } catch { return 0; }
}
