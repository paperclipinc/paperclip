import type { Db } from "@paperclipai/db";
import { connectionService } from "./connections.js";
import { logger } from "../middleware/logger.js";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BUFFER_MINUTES = 10;

export function startConnectionRefreshJob(db: Db): { stop: () => void } {
  const svc = connectionService(db);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick() {
    try {
      const expiring = await svc.listExpiringSoon(BUFFER_MINUTES);
      if (expiring.length === 0) return;

      logger.info(
        { count: expiring.length },
        "Refreshing expiring OAuth connections",
      );

      for (const conn of expiring) {
        try {
          await svc.refreshToken(conn.id);
          logger.info(
            { connectionId: conn.id, provider: conn.providerId },
            "Refreshed OAuth token",
          );
        } catch (err) {
          logger.warn(
            { connectionId: conn.id, provider: conn.providerId, err },
            "Failed to refresh OAuth token",
          );
          // Connection status already updated to "expired" by refreshToken()
        }
      }
    } catch (err) {
      logger.error({ err }, "Connection refresh job tick failed");
    }
  }

  // Start the interval
  timer = setInterval(tick, REFRESH_INTERVAL_MS);

  // Run once on startup (delayed to let server fully boot)
  setTimeout(tick, 10_000);

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
