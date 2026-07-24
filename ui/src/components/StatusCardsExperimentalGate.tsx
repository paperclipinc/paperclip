import type { ReactNode } from "react";
import { Navigate } from "@/lib/router";
import { useFeatures } from "@/hooks/useFeatures";

/**
 * Route guard for the experimental Status Cards feature. Redirects to the
 * dashboard when `enableStatusCards` is off, mirroring
 * {@link CasesExperimentalGate}. Reads flags via useFeatures (capabilities),
 * never /instance/settings directly (fork features-migration guard).
 */
export function StatusCardsExperimentalGate({ children }: { children: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useFeatures();

  if (!isFetched) return null;
  if (experimentalSettings?.enableStatusCards !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
