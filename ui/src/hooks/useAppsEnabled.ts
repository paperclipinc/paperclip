<<<<<<< HEAD
import { useFeatures } from "@/hooks/useFeatures";

export function useAppsEnabled() {
  const query = useFeatures();
=======
import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export function useAppsEnabled() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
>>>>>>> origin/master

  return {
    enabled: query.data?.enableApps === true,
    loaded: query.isFetched,
  };
}
