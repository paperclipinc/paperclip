export interface ModelRate { input: number; cachedInput: number; output: number; }
export type CloudPriceTable = Record<string, ModelRate>;
export function parsePriceTable(raw: string | undefined): CloudPriceTable {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as CloudPriceTable;
  } catch { return {}; }
}
export interface PriceInput {
  model: string; billingType: string; costUsd: number | null | undefined;
  inputTokens: number; cachedInputTokens: number; outputTokens: number;
}
// Resolve a model's rate from the price table. cost_events.model carries the
// dialect/provider prefix the adapter ran with (e.g. "openai/z-ai/glm-5.2",
// "anthropic/tensorix/deepseek/deepseek-chat-v3.1", "tensorix/deepseek/...") but
// the table is keyed by the BARE provider model id. An exact-only lookup missed
// on every real run -> cost 0 -> we would bleed at launch. Try the full id first,
// then strip leading "<segment>/" prefixes one at a time and take the longest
// table-key suffix that matches (longest-first, so the real key wins before a
// shorter accidental suffix).
function resolveModelRate(table: CloudPriceTable, model: string): ModelRate | undefined {
  if (table[model]) return table[model];
  let rest = model;
  let slash = rest.indexOf("/");
  while (slash >= 0) {
    rest = rest.slice(slash + 1);
    if (table[rest]) return table[rest];
    slash = rest.indexOf("/");
  }
  return undefined;
}

export function priceCloudTokens(table: CloudPriceTable, input: PriceInput): number | null {
  // Trust an adapter-reported cost ONLY when it is POSITIVE. The opencode adapter sums
  // part.cost from the stream, which via our Bifrost vk is always 0 (Tensorix returns no
  // per-token cost) with billingType "unknown" -- a literal 0 means "no cost signal", NOT
  // "this run was free", so we must fall through to the wholesale table. (Trusting the 0
  // here metered every managed run to 0 -> 100% bleed, even after the prefix-key fix.)
  if (typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd > 0) return input.costUsd;
  if (input.billingType === "subscription_included") return null;
  const rate = resolveModelRate(table, input.model);
  if (!rate) return null;
  const per = (tokens: number, usdPerM: number) => (tokens / 1_000_000) * usdPerM;
  return per(input.inputTokens, rate.input) + per(input.cachedInputTokens, rate.cachedInput) + per(input.outputTokens, rate.output);
}
