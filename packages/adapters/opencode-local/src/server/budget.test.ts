import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_OPENCODE_RUN_BUDGET_MS,
  isOpenCodeBudgetStop,
  planOpenCodeBudget,
  resolveOpenCodeRunBudgetMs,
  wrapCommandWithTimeout,
} from "./budget.js";

describe("resolveOpenCodeRunBudgetMs", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_RUN_BUDGET_MS;
  });

  it("defaults to 10 minutes when nothing is configured", () => {
    expect(resolveOpenCodeRunBudgetMs({ config: {}, env: {} })).toBe(
      DEFAULT_OPENCODE_RUN_BUDGET_MS,
    );
  });

  it("prefers config.maxRunDurationMs", () => {
    expect(
      resolveOpenCodeRunBudgetMs({ config: { maxRunDurationMs: 120_000 }, env: {} }),
    ).toBe(120_000);
  });

  it("config <= 0 disables the budget", () => {
    expect(resolveOpenCodeRunBudgetMs({ config: { maxRunDurationMs: 0 }, env: {} })).toBe(0);
    expect(resolveOpenCodeRunBudgetMs({ config: { maxRunDurationMs: -5 }, env: {} })).toBe(0);
  });

  it("reads the run env when config is absent", () => {
    expect(
      resolveOpenCodeRunBudgetMs({
        config: {},
        env: { PAPERCLIP_OPENCODE_RUN_BUDGET_MS: "300000" },
      }),
    ).toBe(300_000);
  });

  it("falls back to the process env", () => {
    expect(
      resolveOpenCodeRunBudgetMs({
        config: {},
        env: {},
        processEnv: { PAPERCLIP_OPENCODE_RUN_BUDGET_MS: "60000" },
      }),
    ).toBe(60_000);
  });

  it("falls back to the default on a non-numeric env (never silently disables)", () => {
    expect(
      resolveOpenCodeRunBudgetMs({ config: {}, env: { PAPERCLIP_OPENCODE_RUN_BUDGET_MS: "abc" } }),
    ).toBe(DEFAULT_OPENCODE_RUN_BUDGET_MS);
  });
});

describe("planOpenCodeBudget", () => {
  it("is active and tighter than an unbounded outer timeout", () => {
    const plan = planOpenCodeBudget({ budgetMs: 600_000, outerTimeoutSec: 0, graceSec: 20 });
    expect(plan.enabled).toBe(true);
    expect(plan.budgetSec).toBe(600);
    expect(plan.graceSec).toBe(20);
    expect(plan.effectiveTimeoutSec).toBe(600);
  });

  it("is active when tighter than a bounded outer timeout", () => {
    const plan = planOpenCodeBudget({ budgetMs: 600_000, outerTimeoutSec: 900, graceSec: 20 });
    expect(plan.enabled).toBe(true);
    expect(plan.effectiveTimeoutSec).toBe(600);
  });

  it("is disabled when the budget is at or above the outer timeout", () => {
    const plan = planOpenCodeBudget({ budgetMs: 900_000, outerTimeoutSec: 600, graceSec: 20 });
    expect(plan.enabled).toBe(false);
    expect(plan.effectiveTimeoutSec).toBe(600);
  });

  it("is disabled when the budget is 0", () => {
    const plan = planOpenCodeBudget({ budgetMs: 0, outerTimeoutSec: 600, graceSec: 20 });
    expect(plan.enabled).toBe(false);
    expect(plan.effectiveTimeoutSec).toBe(600);
  });

  it("rounds a sub-second budget up to at least 1s", () => {
    const plan = planOpenCodeBudget({ budgetMs: 500, outerTimeoutSec: 0, graceSec: 20 });
    expect(plan.budgetSec).toBe(1);
    expect(plan.enabled).toBe(true);
  });
});

describe("wrapCommandWithTimeout", () => {
  it("wraps the command with coreutils timeout + graceful TERM-then-KILL", () => {
    const wrapped = wrapCommandWithTimeout({
      command: "opencode",
      args: ["run", "--format", "json", "--model", "m"],
      budgetSec: 600,
      graceSec: 20,
    });
    expect(wrapped.command).toBe("timeout");
    expect(wrapped.args).toEqual([
      "--signal=TERM",
      "--kill-after=20s",
      "600s",
      "opencode",
      "run",
      "--format",
      "json",
      "--model",
      "m",
    ]);
  });
});

describe("isOpenCodeBudgetStop", () => {
  it("returns false when the budget is disabled", () => {
    expect(
      isOpenCodeBudgetStop({
        budgetEnabled: false,
        remote: false,
        exitCode: 143,
        signal: "SIGTERM",
        timedOut: true,
      }),
    ).toBe(false);
  });

  it("local: treats timedOut as a budget stop", () => {
    expect(
      isOpenCodeBudgetStop({
        budgetEnabled: true,
        remote: false,
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
      }),
    ).toBe(true);
  });

  it("local: a clean exit 0 is NOT a budget stop", () => {
    expect(
      isOpenCodeBudgetStop({
        budgetEnabled: true,
        remote: false,
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
    ).toBe(false);
  });

  it("remote: timeout exit 124 / 137 / 143 are budget stops", () => {
    for (const exitCode of [124, 137, 143]) {
      expect(
        isOpenCodeBudgetStop({
          budgetEnabled: true,
          remote: true,
          exitCode,
          signal: null,
          timedOut: false,
        }),
      ).toBe(true);
    }
  });

  it("remote: a real non-budget failure (exit 1) is NOT a budget stop", () => {
    expect(
      isOpenCodeBudgetStop({
        budgetEnabled: true,
        remote: true,
        exitCode: 1,
        signal: null,
        timedOut: false,
      }),
    ).toBe(false);
  });

  it("remote: a clean exit 0 is NOT a budget stop", () => {
    expect(
      isOpenCodeBudgetStop({
        budgetEnabled: true,
        remote: true,
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
    ).toBe(false);
  });

  it("local: a SIGTERM (no timedOut flag) is a budget stop", () => {
    // When the runner signals the process group, the budget SIGTERM can surface
    // as a signal/143 exit rather than the runner's own timedOut flag.
    expect(
      isOpenCodeBudgetStop({
        budgetEnabled: true,
        remote: false,
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
      }),
    ).toBe(true);
    expect(
      isOpenCodeBudgetStop({
        budgetEnabled: true,
        remote: false,
        exitCode: 143,
        signal: null,
        timedOut: false,
      }),
    ).toBe(true);
  });

  it("local: a real non-budget failure (exit 1) is NOT a budget stop", () => {
    expect(
      isOpenCodeBudgetStop({
        budgetEnabled: true,
        remote: false,
        exitCode: 1,
        signal: null,
        timedOut: false,
      }),
    ).toBe(false);
  });

  it("a remote timeout exit code is NOT a budget stop when the budget is disabled", () => {
    expect(
      isOpenCodeBudgetStop({
        budgetEnabled: false,
        remote: true,
        exitCode: 124,
        signal: null,
        timedOut: false,
      }),
    ).toBe(false);
  });
});
