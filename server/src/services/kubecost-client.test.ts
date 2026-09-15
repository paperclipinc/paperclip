import { describe, expect, it, vi } from "vitest";
import { computeCostUsdForRun } from "./kubecost-client.js";

const start = new Date("2026-06-13T10:00:00Z");
const end = new Date("2026-06-13T10:05:00Z");

describe("computeCostUsdForRun", () => {
  it("queries the allocation API for the run window + run-id label and sums the allocated cost", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/model/allocation");
      expect(url).toContain("window=2026-06-13T10:00:00Z,2026-06-13T10:05:00Z");
      expect(url).toContain("paperclip.io/run-id");
      expect(url).toContain("run_abc");
      return { ok: true, status: 200, json: async () => ({
        data: [{ "run_abc": { totalCost: 0.0123, cpuCost: 0.008, ramCost: 0.0043 } }],
      }) };
    }) as unknown as typeof fetch;
    const usd = await computeCostUsdForRun(
      { baseUrl: "http://kubecost.kubecost.svc.cluster.local:9090" },
      { runId: "run_abc", namespace: "paperclip-tenant-acme", start, end },
      fetchImpl,
    );
    expect(usd).toBeCloseTo(0.0123, 6);
  });
  it("returns 0 when Kubecost is unreachable (graceful degrade, never fails the run)", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const usd = await computeCostUsdForRun({ baseUrl: "http://kubecost.invalid:9090" }, { runId: "run_abc", namespace: "ns", start, end }, fetchImpl);
    expect(usd).toBe(0);
  });
  it("returns 0 on a non-2xx or empty allocation set", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as unknown as typeof fetch;
    expect(await computeCostUsdForRun({ baseUrl: "http://k:9090" }, { runId: "r", namespace: "ns", start, end }, fetchImpl)).toBe(0);
  });
  it("returns 0 when no baseUrl is configured (compute pricing off)", async () => {
    expect(await computeCostUsdForRun({ baseUrl: "" }, { runId: "r", namespace: "ns", start, end })).toBe(0);
  });

  it("filters by the run-id label alone when no namespace is resolvable (cloud_tenant)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("paperclip.io/run-id");
      expect(url).toContain("run_abc");
      // No empty namespace clause when namespace is "".
      expect(url).not.toContain('namespace:""');
      return { ok: true, status: 200, json: async () => ({ data: [{ run_abc: { totalCost: 0.05 } }] }) };
    }) as unknown as typeof fetch;
    const usd = await computeCostUsdForRun(
      { baseUrl: "http://k:9090" },
      { runId: "run_abc", namespace: "", start, end },
      fetchImpl,
    );
    expect(usd).toBeCloseTo(0.05, 6);
  });
});
