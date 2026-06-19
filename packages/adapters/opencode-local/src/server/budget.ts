import { asNumber } from "@paperclipai/adapter-utils/server-utils";

// Bounded-resumable-wake support for opencode_local.
//
// opencode's CLI has no turn/step/max bound (confirmed against opencode
// v1.17.x: `opencode run --help` exposes no loop-bounding flag), so a single
// `opencode run` invocation runs the whole task until it finishes or is killed
// by the sandbox RPC timeout (SIGKILL/137) -> work + tokens lost, the build
// never accumulates across wakes.
//
// claude_local gets bounded wakes via `--max-turns`: it does a bounded chunk,
// stops with stopReason `max_turns_exhausted` (a NORMAL stop, not a failure),
// and the heartbeat's MAX_TURN continuation policy auto-wakes + resumes the
// session. We give opencode the SAME behavior with a graceful wall-clock
// TIME-BOX instead of a turn count: run opencode under a budget, send SIGTERM
// (NOT SIGKILL) at the budget so opencode flushes/persists its session and
// exits, then map that budget-induced stop to the EXACT SAME
// `max_turns_exhausted` stop reason claude uses, so the existing heartbeat
// continuation policy fires unchanged.

/**
 * Default per-run wall-clock budget for opencode (10 minutes). Chosen to sit
 * comfortably under the sandbox RPC cap (~15min) so the budget's graceful
 * SIGTERM always fires BEFORE the hard RPC SIGKILL.
 */
export const DEFAULT_OPENCODE_RUN_BUDGET_MS = 600_000;

/**
 * Resolve the configured per-run budget in milliseconds.
 *
 * Precedence: `config.maxRunDurationMs` -> run env `PAPERCLIP_OPENCODE_RUN_BUDGET_MS`
 * -> process env `PAPERCLIP_OPENCODE_RUN_BUDGET_MS` -> {@link DEFAULT_OPENCODE_RUN_BUDGET_MS}.
 *
 * A value `<= 0` disables the budget (returns 0). NaN / non-numeric falls back
 * to the default so a typo cannot silently disable the bound.
 */
export function resolveOpenCodeRunBudgetMs(input: {
  config: Record<string, unknown>;
  env: Record<string, string>;
  processEnv?: Record<string, string | undefined>;
}): number {
  const processEnv = input.processEnv ?? {};
  const configHasBudget = Object.prototype.hasOwnProperty.call(input.config, "maxRunDurationMs");
  if (configHasBudget) {
    const fromConfig = asNumber(input.config.maxRunDurationMs, Number.NaN);
    if (Number.isFinite(fromConfig)) {
      return fromConfig > 0 ? Math.floor(fromConfig) : 0;
    }
  }

  const rawEnv =
    input.env.PAPERCLIP_OPENCODE_RUN_BUDGET_MS ?? processEnv.PAPERCLIP_OPENCODE_RUN_BUDGET_MS;
  if (typeof rawEnv === "string" && rawEnv.trim().length > 0) {
    const parsed = Number(rawEnv.trim());
    if (Number.isFinite(parsed)) {
      return parsed > 0 ? Math.floor(parsed) : 0;
    }
  }

  return DEFAULT_OPENCODE_RUN_BUDGET_MS;
}

export interface OpenCodeBudgetPlan {
  /** Whether the budget is active (a positive budget that is tighter than the outer timeout). */
  enabled: boolean;
  /** The budget in whole seconds (coreutils `timeout` takes a duration in seconds). */
  budgetSec: number;
  /** Grace period (seconds) between SIGTERM and SIGKILL. */
  graceSec: number;
  /**
   * The effective wall-clock timeout (seconds) to hand the LOCAL child-process
   * runner. When the budget is active this is the budget; otherwise it is the
   * caller's outer timeout (0 == unbounded).
   */
  effectiveTimeoutSec: number;
}

/**
 * Plan the time-box for a run.
 *
 * `outerTimeoutSec` is the adapter's resolved timeout (0 == unbounded, e.g. the
 * sandbox RPC cap is enforced separately by the runner). The budget is only
 * "active" when it is positive AND strictly tighter than the outer timeout
 * (when the outer timeout is bounded) -- a budget at or above the outer cap
 * would never fire first, so there is nothing to gain from the graceful path.
 */
export function planOpenCodeBudget(input: {
  budgetMs: number;
  outerTimeoutSec: number;
  graceSec: number;
}): OpenCodeBudgetPlan {
  const graceSec = Math.max(1, Math.floor(input.graceSec));
  const outerTimeoutSec = input.outerTimeoutSec > 0 ? Math.floor(input.outerTimeoutSec) : 0;
  // Round the budget UP to whole seconds so a sub-second remainder never
  // truncates the budget to 0s (which `timeout` treats as "no timeout").
  const budgetSec = input.budgetMs > 0 ? Math.max(1, Math.ceil(input.budgetMs / 1000)) : 0;

  const enabled =
    budgetSec > 0 && (outerTimeoutSec === 0 || budgetSec < outerTimeoutSec);

  return {
    enabled,
    budgetSec,
    graceSec,
    effectiveTimeoutSec: enabled ? budgetSec : outerTimeoutSec,
  };
}

/**
 * Wrap a command + args with GNU coreutils `timeout` so the REMOTE/sandbox path
 * gets the same graceful SIGTERM-then-SIGKILL budget the local child-process
 * runner applies. The sandbox runner does exec-and-collect with its own RPC
 * `timeoutMs` (a hard SIGKILL); wrapping with `timeout` makes opencode receive a
 * SIGTERM at the budget FIRST, so it flushes/persists its session before the
 * RPC cap would SIGKILL it.
 *
 * `timeout --signal=TERM --kill-after=<grace>s <budget>s opencode run ...`:
 *   - sends SIGTERM at <budget>s,
 *   - escalates to SIGKILL <grace>s later if opencode has not exited.
 * Exit codes: 124 when the command was still running at the deadline (and was
 * signalled), 128+signal (e.g. 137) if `timeout` itself was killed.
 */
export function wrapCommandWithTimeout(input: {
  command: string;
  args: string[];
  budgetSec: number;
  graceSec: number;
  timeoutBin?: string;
}): { command: string; args: string[] } {
  const timeoutBin = input.timeoutBin ?? "timeout";
  return {
    command: timeoutBin,
    args: [
      "--signal=TERM",
      `--kill-after=${input.graceSec}s`,
      `${input.budgetSec}s`,
      input.command,
      ...input.args,
    ],
  };
}

/**
 * Decide whether a finished run was terminated by the budget (a BOUNDED stop)
 * rather than having genuinely completed or hard-failed.
 *
 * - LOCAL path: the child-process runner sets `timedOut` when its wall-clock
 *   timer fired; when the budget is the effective timeout that IS the budget.
 * - REMOTE path: `timeout` returns 124 (deadline reached, child signalled) or
 *   137 (128+9, SIGKILL after `--kill-after`). 143 (128+15, SIGTERM) can also
 *   surface if opencode re-raised TERM. Any of those, with the budget active,
 *   is a budget stop.
 *
 * A genuinely-finished opencode run exits 0 (or non-zero for a real error that
 * is NOT one of the budget signals), so it is never misread as a budget stop.
 */
export function isOpenCodeBudgetStop(input: {
  budgetEnabled: boolean;
  remote: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}): boolean {
  if (!input.budgetEnabled) return false;

  if (input.remote) {
    // `timeout` deadline exit codes. 124: ran past the deadline (TERM sent).
    // 137: SIGKILL after --kill-after. 143: SIGTERM propagated by the child.
    return input.exitCode === 124 || input.exitCode === 137 || input.exitCode === 143;
  }

  // Local: the runner's own SIGTERM-at-timeout path sets timedOut. SIGTERM may
  // also surface as a signal/143 exit when the process group is signalled.
  return (
    input.timedOut ||
    input.signal === "SIGTERM" ||
    input.exitCode === 143
  );
}
