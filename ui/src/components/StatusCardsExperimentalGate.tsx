import type { ReactNode } from "react";
import { Navigate } from "@/lib/router";
import { useFeatures } from "@/hooks/useFeatures";

export function StatusCardsExperimentalGate({ children }: { children: ReactNode }) {
  const { data: features, isFetched } = useFeatures();

  if (!isFetched) return null;
  if (features?.enableStatusCards !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
