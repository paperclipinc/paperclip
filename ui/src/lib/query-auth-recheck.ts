import type { QueryClient } from "@tanstack/react-query";
import { isAuthFailure } from "./query-auth-policy";
import { queryKeys } from "./queryKeys";

const SESSION_KEY = JSON.stringify(queryKeys.auth.session);

/**
 * Give CloudAccessGate a feedback path from the rest of the app.
 *
 * The gate decides "signed out, go to /auth/sign-in" from its own session
 * query alone. That query is stale-cached, so when a session dies mid-visit
 * nothing tells the gate: every other query starts returning 401 and just
 * keeps polling on its interval, and the user sits in front of an app that
 * quietly stops loading instead of being sent to sign-in.
 *
 * Any auth failure anywhere is therefore treated as a reason to re-ask the one
 * question that matters. If the session really is gone the session query
 * resolves null and the gate redirects once; if it is fine (a per-resource 403)
 * the answer is unchanged and nothing happens.
 */
export function installAuthFailureRecheck(queryClient: QueryClient): () => void {
  let recheckInFlight = false;

  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    if (event.query.state.status !== "error") return;
    if (!isAuthFailure(event.query.state.error)) return;
    // The session query answering 401 IS the answer; re-asking would loop.
    if (JSON.stringify(event.query.queryKey) === SESSION_KEY) return;
    // A dead session fails every query on the page at once. One re-check
    // answers all of them.
    if (recheckInFlight) return;

    recheckInFlight = true;
    void queryClient
      .refetchQueries({ queryKey: queryKeys.auth.session, exact: true })
      .finally(() => {
        recheckInFlight = false;
      });
  });
}
