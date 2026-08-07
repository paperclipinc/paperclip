import type { ReactNode } from "react";
<<<<<<< HEAD
import { Navigate } from "@/lib/router";
import { useFeatures } from "@/hooks/useFeatures";

export function PipelinesExperimentalGate({ children }: { children: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useFeatures();
=======
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export function PipelinesExperimentalGate({ children }: { children: ReactNode }) {
  const { data: experimentalSettings, isFetched } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
>>>>>>> origin/master

  if (!isFetched) return null;
  if (experimentalSettings?.enablePipelines !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
