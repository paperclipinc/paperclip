import type { ReactNode } from "react";
<<<<<<< HEAD
import { Navigate } from "@/lib/router";
import { useFeatures } from "@/hooks/useFeatures";
=======
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
>>>>>>> origin/master

/**
 * Route guard for the experimental Cases feature (PAP-12947). Redirects to the
 * dashboard when `enableCases` is off, mirroring {@link PipelinesExperimentalGate}.
 */
export function CasesExperimentalGate({ children }: { children: ReactNode }) {
<<<<<<< HEAD
  const { data: experimentalSettings, isFetched } = useFeatures();
=======
  const { data: experimentalSettings, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
>>>>>>> origin/master

  if (!isFetched) return null;
  if (experimentalSettings?.enableCases !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
