import { useFeatures } from "./useFeatures";

// Board users cannot read /instance/settings in this fork (instance-admin
// only), so the flag rides the capabilities payload like every other one.
export function useAgentChatEnabled() {
  const query = useFeatures();
  return {
    enabled: query.data?.enableAgentChat === true,
    loaded: query.isFetched,
  };
}
