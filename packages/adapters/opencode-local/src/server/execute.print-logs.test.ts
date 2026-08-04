import { describe, expect, it } from "vitest";
import { resolveOpenCodePrintLogs } from "./execute.js";

describe("resolveOpenCodePrintLogs", () => {
  // OpenCode reports a rejected model, and several other upstream faults, as
  // "Unexpected server error. Check server logs for details." Two hosted
  // companies in one 48h window had runs recorded with nothing but that text.
  // On a managed sandbox there are no server logs to check: the pod dies with
  // the lease, so the only copy of the cause goes with it.

  it("turns the diagnostic on for a managed sandbox, where the log file is unreachable", () => {
    expect(resolveOpenCodePrintLogs({ configured: undefined, usesManagedSandbox: true })).toBe(true);
  });

  it("leaves a local run alone, where the operator can read the log file", () => {
    expect(resolveOpenCodePrintLogs({ configured: undefined, usesManagedSandbox: false })).toBe(
      false,
    );
  });

  it("lets an explicit opt-out win on a sandbox", () => {
    expect(resolveOpenCodePrintLogs({ configured: "0", usesManagedSandbox: true })).toBe(false);
    expect(resolveOpenCodePrintLogs({ configured: "false", usesManagedSandbox: true })).toBe(false);
  });

  it("lets an explicit opt-in win locally", () => {
    expect(resolveOpenCodePrintLogs({ configured: "1", usesManagedSandbox: false })).toBe(true);
    expect(resolveOpenCodePrintLogs({ configured: "true", usesManagedSandbox: false })).toBe(true);
  });

  it("treats an empty value as unset rather than as an opt-out", () => {
    // An env var declared but left blank must not silently disable the only
    // diagnostic a hosted run has.
    expect(resolveOpenCodePrintLogs({ configured: "", usesManagedSandbox: true })).toBe(true);
    expect(resolveOpenCodePrintLogs({ configured: "   ", usesManagedSandbox: true })).toBe(true);
  });
});
