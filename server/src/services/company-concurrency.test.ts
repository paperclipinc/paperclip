import { describe, expect, it } from "vitest";
import { resolveCompanyConcurrencyCap, clampToCompanyConcurrency } from "./company-concurrency.js";

describe("resolveCompanyConcurrencyCap", () => {
  it("returns null (unbounded) when env unset — self-host parity", () => {
    expect(resolveCompanyConcurrencyCap({})).toBeNull();
  });
  it("reads a positive integer cap", () => {
    expect(resolveCompanyConcurrencyCap({ PAPERCLIP_CLOUD_MAX_CONCURRENT_RUNS_PER_COMPANY: "8" })).toBe(8);
  });
  it("ignores non-positive / non-numeric (treated unset)", () => {
    expect(resolveCompanyConcurrencyCap({ PAPERCLIP_CLOUD_MAX_CONCURRENT_RUNS_PER_COMPANY: "0" })).toBeNull();
    expect(resolveCompanyConcurrencyCap({ PAPERCLIP_CLOUD_MAX_CONCURRENT_RUNS_PER_COMPANY: "x" })).toBeNull();
  });
});
describe("clampToCompanyConcurrency", () => {
  it("no-op when cap null", () => {
    expect(clampToCompanyConcurrency({ perAgentSlots: 5, companyRunningCount: 100, companyCap: null })).toBe(5);
  });
  it("clamps to per-company remaining headroom", () => {
    expect(clampToCompanyConcurrency({ perAgentSlots: 5, companyRunningCount: 8, companyCap: 10 })).toBe(2);
  });
  it("returns 0 at/over cap", () => {
    expect(clampToCompanyConcurrency({ perAgentSlots: 5, companyRunningCount: 10, companyCap: 10 })).toBe(0);
    expect(clampToCompanyConcurrency({ perAgentSlots: 5, companyRunningCount: 12, companyCap: 10 })).toBe(0);
  });
  it("never raises above per-agent slots", () => {
    expect(clampToCompanyConcurrency({ perAgentSlots: 2, companyRunningCount: 0, companyCap: 10 })).toBe(2);
  });
});
