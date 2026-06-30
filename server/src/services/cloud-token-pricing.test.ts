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

  // cost_events.model carries the DIALECT/PROVIDER prefix the adapter ran with
  // (e.g. "openai/z-ai/glm-5.2", "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
  // "tensorix/deepseek/deepseek-chat-v3.1"), but the wholesale price table is keyed
  // by the BARE provider model id. An exact-match lookup misses on every real run ->
  // cost 0 -> we bleed at launch. The lookup must resolve the longest table-key
  // suffix of the prefixed model id.
  const glm = parsePriceTable(JSON.stringify({
    "z-ai/glm-5.2": { input: 1.39, cachedInput: 1.39, output: 4.17 },
    "deepseek/deepseek-chat-v3.1": { input: 0.6, cachedInput: 0.15, output: 1.8 },
  }));
  it("matches a price-table key when the model id carries an openai/ dialect prefix", () => {
    const usd = priceCloudTokens(glm, {
      model: "openai/z-ai/glm-5.2", billingType: "subscription_overage", costUsd: null,
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0,
    });
    expect(usd).toBeCloseTo(1.39, 6);
  });
  it("matches through a multi-segment anthropic/tensorix/ prefix", () => {
    const usd = priceCloudTokens(glm, {
      model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1", billingType: "subscription_overage", costUsd: null,
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0,
    });
    expect(usd).toBeCloseTo(0.6, 6);
  });
  it("matches through a single tensorix/ provider prefix", () => {
    const usd = priceCloudTokens(glm, {
      model: "tensorix/deepseek/deepseek-chat-v3.1", billingType: "subscription_overage", costUsd: null,
      inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(1.8, 6);
  });
  it("still returns null when NO suffix of the prefixed model is in the table (no false match)", () => {
    expect(priceCloudTokens(glm, {
      model: "openai/some/unpriced-model", billingType: "subscription_overage", costUsd: null,
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 100,
    })).toBeNull();
  });
});
