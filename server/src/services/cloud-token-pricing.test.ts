import { describe, expect, it } from "vitest";
import { priceCloudTokens, parsePriceTable } from "./cloud-token-pricing.js";

const table = parsePriceTable(JSON.stringify({
  "deepseek/deepseek-v4-pro": { input: 0.6, cachedInput: 0.15, output: 1.8 },
}));

describe("priceCloudTokens", () => {
  it("prices a managed run from tokens x the WHOLESALE per-model table (no margin yet)", () => {
    const usd = priceCloudTokens(table, {
      model: "deepseek/deepseek-v4-pro", billingType: "subscription_overage", costUsd: null,
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 500_000,
    });
    expect(usd).toBeCloseTo(1.5, 6);
  });
  it("returns the existing costUsd untouched when the adapter already priced it (BYOK/provider-billed)", () => {
    const usd = priceCloudTokens(table, {
      model: "deepseek/deepseek-v4-pro", billingType: "metered_api", costUsd: 0.42,
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 100,
    });
    expect(usd).toBe(0.42);
  });
  it("returns null (skip metering) for a BYOK/subscription_included run", () => {
    expect(priceCloudTokens(table, {
      model: "deepseek/deepseek-v4-pro", billingType: "subscription_included", costUsd: null,
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 100,
    })).toBeNull();
  });
  it("returns null for a model not in the table (degrade safely to today's 0)", () => {
    expect(priceCloudTokens(table, {
      model: "unknown/model", billingType: "subscription_overage", costUsd: null,
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 100,
    })).toBeNull();
  });
  it("parsePriceTable tolerates an empty/invalid env (returns an empty table)", () => {
    expect(parsePriceTable(undefined)).toEqual({});
    expect(parsePriceTable("not json")).toEqual({});
  });
});
