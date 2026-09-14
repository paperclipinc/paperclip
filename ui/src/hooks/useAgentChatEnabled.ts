import { useFeatures } from "./useFeatures";

export function useAgentChatEnabled() {
  const query = useFeatures();
  return {
    enabled: query.data?.enableAgentChat === true,
    loaded: query.isFetched,
  };
}
