import { useFeatures } from "./useFeatures";

/**
 * Classic Task Interface experimental flag (`enableClassicTaskInterface`).
 *
 * Reads from the fork's PublicFeatureFlags (via useFeatures) so it works for
 * non-admin users. Fail-closed to chat-style: `enabled` stays false while the
 * query is in flight, on fetch errors, and in renders without a
 * QueryClientProvider, so the default chat-style view renders unless the
 * classic opt-in is provably on. `loaded` lets hosts that care distinguish
 * "flag is off" from "flag not yet known".
 */
export function useClassicTaskInterfaceEnabled(): { enabled: boolean; loaded: boolean } {
  const { data: features, isFetched } = useFeatures();
  return {
    enabled: features?.enableClassicTaskInterface === true,
    loaded: isFetched,
  };
}
