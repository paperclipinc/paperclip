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
export function priceCloudTokens(table: CloudPriceTable, input: PriceInput): number | null {
  if (typeof input.costUsd === "number" && Number.isFinite(input.costUsd)) return input.costUsd;
  if (input.billingType === "subscription_included") return null;
  const rate = table[input.model];
  if (!rate) return null;
  const per = (tokens: number, usdPerM: number) => (tokens / 1_000_000) * usdPerM;
  return per(input.inputTokens, rate.input) + per(input.cachedInputTokens, rate.cachedInput) + per(input.outputTokens, rate.output);
}
