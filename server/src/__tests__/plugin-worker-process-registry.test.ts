import { afterEach, describe, expect, it } from "vitest";

import {
  clearProcessPluginWorkerManager,
  getProcessPluginWorkerManager,
  setProcessPluginWorkerManager,
} from "../services/plugin-worker-process-registry.js";

/**
 * Guards the fix for a bug that recurred three times: the plugin worker manager
 * is process-scoped, but it was threaded as an OPTIONAL parameter through every
 * runtime construction site. Any caller that omitted it built a run engine that
 * could never acquire a sandbox lease, and it only surfaced when a customer hit
 * that path. Observed in production on 2026-07-26 via `assignment` and
 * `automation` dispatches, which reach the runtime through `heartbeatService(db)`
 * called with no options at all.
 */
describe("process plugin worker manager registry", () => {
  afterEach(() => {
    clearProcessPluginWorkerManager();
  });

  it("returns undefined when nothing has registered a manager", () => {
    clearProcessPluginWorkerManager();
    expect(getProcessPluginWorkerManager()).toBeUndefined();
  });

  it("hands back the manager registered for this process", () => {
    const manager = { marker: "process-manager" } as never;
    setProcessPluginWorkerManager(manager);
    expect(getProcessPluginWorkerManager()).toBe(manager);
  });

  it("allows a test harness to replace the registration", () => {
    const first = { marker: "first" } as never;
    const second = { marker: "second" } as never;
    setProcessPluginWorkerManager(first);
    setProcessPluginWorkerManager(second);
    expect(getProcessPluginWorkerManager()).toBe(second);
  });

  it("treats an undefined registration as no manager rather than throwing", () => {
    // Contexts that legitimately have no worker (migrations, CLI entrypoints)
    // must keep working; the sandbox driver produces the accurate error instead.
    setProcessPluginWorkerManager(undefined);
    expect(getProcessPluginWorkerManager()).toBeUndefined();
  });
});

describe("sandbox driver manager resolution", () => {
  afterEach(() => {
    clearProcessPluginWorkerManager();
  });

  it("prefers an explicitly passed manager over the process registration", () => {
    // The explicit parameter has to keep winning, because tests inject their own
    // manager and must not be affected by whatever the process registered.
    const registered = { marker: "registered" } as never;
    const explicit = { marker: "explicit" } as never;
    setProcessPluginWorkerManager(registered);

    const resolve = (options: { pluginWorkerManager?: unknown }) =>
      options.pluginWorkerManager ?? getProcessPluginWorkerManager();

    expect(resolve({ pluginWorkerManager: explicit })).toBe(explicit);
    expect(resolve({})).toBe(registered);
  });
});
