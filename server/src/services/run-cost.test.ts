import { describe, expect, it } from "vitest";
import {
  billedCostCents,
  parseMargin,
  parseComputeRatePerHour,
  deterministicComputeUsd,
  resolveComputeUsd,
} from "./run-cost.js";

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

describe("deterministicComputeUsd (the compute floor that prevents 0-compute bills)", () => {
  it("prices a run by its wall-clock duration x the pod-hour rate", () => {
    // 30 min at $0.05/pod-hour = $0.025
    expect(deterministicComputeUsd(1800, 0.05)).toBeCloseTo(0.025, 9);
  });
  it("a full hour costs exactly one pod-hour", () => {
    expect(deterministicComputeUsd(3600, 0.05)).toBeCloseTo(0.05, 9);
  });
  it("returns 0 for a non-positive duration (no negative/NaN compute)", () => {
    expect(deterministicComputeUsd(0, 0.05)).toBe(0);
    expect(deterministicComputeUsd(-10, 0.05)).toBe(0);
    expect(deterministicComputeUsd(Number.NaN, 0.05)).toBe(0);
  });
  it("returns 0 when the rate is unset/0 (safe degrade to today's behaviour)", () => {
    expect(deterministicComputeUsd(3600, 0)).toBe(0);
  });
});

describe("parseComputeRatePerHour", () => {
  it("parses a positive number", () => {
    expect(parseComputeRatePerHour("0.05")).toBeCloseTo(0.05, 9);
  });
  it("defaults to 0 (compute disabled) on missing/invalid/negative env", () => {
    expect(parseComputeRatePerHour(undefined)).toBe(0);
    expect(parseComputeRatePerHour("not a number")).toBe(0);
    expect(parseComputeRatePerHour("-1")).toBe(0);
  });
});

describe("resolveComputeUsd (Kubecost preferred, deterministic floor otherwise)", () => {
  it("trusts a POSITIVE Kubecost measurement over the floor", () => {
    // Kubecost said $0.20; the floor would be only $0.05 -> use the real measurement.
    expect(resolveComputeUsd({ kubecostUsd: 0.2, durationSec: 3600, ratePerHour: 0.05 })).toBeCloseTo(0.2, 9);
  });
  it("falls through to the deterministic floor when Kubecost returns 0 (the bug: no compute attributed)", () => {
    expect(resolveComputeUsd({ kubecostUsd: 0, durationSec: 3600, ratePerHour: 0.05 })).toBeCloseTo(0.05, 9);
  });
  it("falls through when Kubecost returns a non-finite/garbage value", () => {
    expect(resolveComputeUsd({ kubecostUsd: Number.NaN, durationSec: 3600, ratePerHour: 0.05 })).toBeCloseTo(0.05, 9);
  });
  it("is 0 when both Kubecost and the floor are 0 (rate unset -> preserves today's behaviour)", () => {
    expect(resolveComputeUsd({ kubecostUsd: 0, durationSec: 3600, ratePerHour: 0 })).toBe(0);
  });
});
