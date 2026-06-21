import { describe, expect, it } from "vitest";
import { billedCostCents, parseMargin } from "./run-cost.js";

describe("billedCostCents (explicit cost-plus margin over wholesale)", () => {
  it("folds model + compute and applies the margin multiplier, ceil to cents", () => {
    expect(billedCostCents({ modelUsd: 1.5, computeUsd: 0.5, margin: 1.3 })).toBe(260);
  });
  it("margin=1 reproduces wholesale (the multiplier is the ONLY markup)", () => {
    expect(billedCostCents({ modelUsd: 1.5, computeUsd: 0.5, margin: 1 })).toBe(200);
  });
  it("ceils fractional cents up (never under-bill)", () => {
    expect(billedCostCents({ modelUsd: 0.001, computeUsd: 0, margin: 1.3 })).toBe(1);
  });
  it("null model cost (skip metering: BYOK/subscription_included) yields 0 cents", () => {
    expect(billedCostCents({ modelUsd: null, computeUsd: 0, margin: 1.3 })).toBe(0);
  });
  it("compute-only still bills (model priced 0 but a known managed model)", () => {
    expect(billedCostCents({ modelUsd: 0, computeUsd: 0.5, margin: 1.3 })).toBe(65);
  });
  it("parseMargin defaults to 1.0 on missing/invalid env (wholesale-only, safe degrade)", () => {
    expect(parseMargin(undefined)).toBe(1);
    expect(parseMargin("not a number")).toBe(1);
    expect(parseMargin("1.3")).toBe(1.3);
    expect(parseMargin("0.5")).toBe(1);
  });
});
