import { Outlet, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { resolveCloudZeroCompanyState } from "@/lib/cloud-zero-company";
import { BootstrapPendingPage } from "@/components/BootstrapPendingPage";
import { WorkspaceSetupPendingPage } from "@/components/WorkspaceSetupPendingPage";
import { Card } from "@/components/ui/card";

// authApi.getSession() only resolves to `null` for a DEFINITIVE
// "not authenticated" answer (an explicit 401, or a 200 whose body doesn't
// parse into a session) — every other failure (429/5xx/network) throws
// instead, specifically so this gate can tell them apart. A rate-limited
// 429 on this exact endpoint, with the session cookie completely intact,
// previously triggered a hard `window.location.replace` to sign-in — see
// bounce-and-probe-investigation.md. Capped exponential backoff (not
// react-query's default) so a transient blip resolves quietly rather than
// hammering an already-rate-limited endpoint.
const SESSION_QUERY_RETRY_DELAYS_MS = [2000, 8000, 30000];
const SESSION_QUERY_MAX_RETRIES = SESSION_QUERY_RETRY_DELAYS_MS.length;
// Once retries are exhausted, keep trying at a slow, steady interval —
// "retrying" in the inline copy below should mean it, not strand the user
// on a page that never recovers even after connectivity/rate-limiting
// clears up. Each of these attempts gets its own SESSION_QUERY_MAX_RETRIES
// sub-retries via the retry/retryDelay options below.
const SESSION_QUERY_ERROR_REFETCH_INTERVAL_MS =
  SESSION_QUERY_RETRY_DELAYS_MS[SESSION_QUERY_RETRY_DELAYS_MS.length - 1];

function NoBoardAccessPage() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">No company access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account is signed in, but it does not have an active company membership or instance-admin access on
          this Paperclip instance.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Use a company invite or sign in with an account that already belongs to this org.
        </p>
      </Card>
    </div>
  );
}

export function CloudAccessGate() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const isBootstrapPending = isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    // A definitive 401 never throws (authApi.getSession resolves it to
    // `null` instead), so anything that reaches retry/error here is, by
    // construction, a non-definitive failure (429/5xx/network) — always
    // worth retrying rather than treating as a logout.
    retry: (failureCount) => failureCount < SESSION_QUERY_MAX_RETRIES,
    retryDelay: (attemptIndex) =>
      SESSION_QUERY_RETRY_DELAYS_MS[attemptIndex] ?? SESSION_QUERY_ERROR_REFETCH_INTERVAL_MS,
    // After the retries above are exhausted, keep checking periodically
    // instead of giving up for good — the inline "retrying" state below
    // should be true, not a euphemism for stuck.
    refetchInterval: (query) => (query.state.status === "error" ? SESSION_QUERY_ERROR_REFETCH_INTERVAL_MS : false),
  });
  // True only once every retry above is exhausted — while retries are in
  // flight, react-query keeps the query in a pending/fetching state, not
  // "error", so this only reflects a SUSTAINED session-check failure.
  const sessionCheckFailing = isAuthenticatedMode && sessionQuery.isError;
  // The one and only definitive "not authenticated" signal: the query
  // resolved successfully (no error, no retries pending) and the resolved
  // session is null.
  const sessionDefinitivelyUnauthenticated =
    isAuthenticatedMode && sessionQuery.isSuccess && sessionQuery.data === null;

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as import("@/api/access").CurrentBoardAccess | undefined;
      if (!data) return false;
      return resolveCloudZeroCompanyState(data) === "waiting" ? 3000 : false;
    },
    refetchIntervalInBackground: true,
  });
  const claimMutation = useMutation({
    mutationFn: () => accessApi.claimBootstrapAdmin(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    },
  });

  if (
    healthQuery.isLoading ||
    (isAuthenticatedMode && sessionQuery.isLoading) ||
    (isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data && boardAccessQuery.isLoading)
  ) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  // The session check has been failing for a non-definitive reason
  // (429/5xx/network) through every retry above — NOT a real logout (that
  // path resolves to `sessionDefinitivelyUnauthenticated` instead, further
  // down, and never reaches here). Stay on this page and keep trying rather
  // than redirecting a possibly-still-valid session out from under the
  // user; refetchInterval above keeps retrying at a slow, steady cadence.
  if (sessionCheckFailing) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Connection problem, retrying...</div>
    );
  }

  if (healthQuery.error || boardAccessQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error
          ? healthQuery.error.message
          : boardAccessQuery.error instanceof Error
            ? boardAccessQuery.error.message
            : "Failed to load app state"}
      </div>
    );
  }

  if (isBootstrapPending) {
    const health = healthQuery.data;
    if (!health) {
      return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
    }
    const claimError = claimMutation.error instanceof ApiError
      ? { status: claimMutation.error.status, message: claimMutation.error.message }
      : claimMutation.error instanceof Error
        ? { message: claimMutation.error.message }
        : null;
    return (
      <BootstrapPendingPage
        claimAvailable={health.deploymentExposure === "private"}
        hasActiveInvite={health.bootstrapInviteActive}
        session={sessionQuery.data}
        claimState={claimMutation.isSuccess ? "success" : claimMutation.isPending ? "claiming" : "idle"}
        claimError={claimError}
        onClaim={() => claimMutation.mutate()}
      />
    );
  }

  if (sessionDefinitivelyUnauthenticated) {
    // cloud: the auth pages live OUTSIDE the SPA (the gateway serves the
    // marketing /auth/* pages). A client-side <Navigate to="/auth"> would render
    // the SPA's own AuthPage instead, so this must be a full page load.
    //
    // Only fires for a DEFINITIVE unauthenticated signal (see
    // sessionDefinitivelyUnauthenticated above) — a 429/5xx/network failure
    // on the session-check request itself is handled by sessionCheckFailing
    // further up instead, and never reaches a redirect while the session
    // cookie could still be perfectly valid.
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    window.location.replace(`/auth/sign-in?next=${next}`);
    return null;
  }

  if (isAuthenticatedMode && sessionQuery.data && boardAccessQuery.data) {
    const zeroCompanyState = resolveCloudZeroCompanyState(boardAccessQuery.data);
    if (zeroCompanyState === "waiting") return <WorkspaceSetupPendingPage />;
    if (zeroCompanyState === "no_access") return <NoBoardAccessPage />;
    // "onboard" and null fall through: Layout auto-opens the onboarding
    // wizard whenever the companies list is empty.
  }

  return <Outlet />;
}
