import { ApiError } from "../api/client";

/** react-query's own default. Kept explicit so the policy reads in one place. */
const MAX_ATTEMPTS = 3;

/**
 * A response that says "this session may not do this". Distinct from a
 * transient failure: no amount of asking again turns a 401 into a 200.
 */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/**
 * Retry predicate for the app-wide QueryClient.
 *
 * Without this, an expired session makes every polling query on the page retry
 * three times and then poll again on its own interval, which is how a single
 * dead session turned into 50-120 requests a minute against /api/* with the
 * user not even touching the page. Auth failures are terminal for the attempt;
 * everything else keeps the stock budget.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isAuthFailure(error)) return false;
  return failureCount < MAX_ATTEMPTS;
}
