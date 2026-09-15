const config = require('../config');
const logger = require('../logger');
const icsFeedService = require('../services/icsFeedService');

/**
 * Starts the periodic ICS feed refresh job (interval configurable via
 * ICS_FEED_SYNC_INTERVAL_MINUTES, default 20). Deliberately not started
 * by app.js/createApp() - tests build the app directly without a live
 * timer running in the background.
 */
function startIcsFeedSyncJob() {
  const intervalMs = config.icsFeedSyncIntervalMinutes * 60_000;

  async function runOnce() {
    try {
      const count = await icsFeedService.syncAllFeeds();
      if (count > 0) {
        logger.info({ feed_count: count }, 'Periodic ICS feed sync completed');
      }
    } catch (err) {
      // Should be unreachable (syncFeed catches per-feed errors), but a
      // sync run must never crash the process regardless.
      logger.error({ err }, 'Periodic ICS feed sync run failed unexpectedly');
    }
  }

  logger.info({ interval_minutes: config.icsFeedSyncIntervalMinutes }, 'Starting ICS feed sync job');
  runOnce();
  return setInterval(runOnce, intervalMs);
}

module.exports = { startIcsFeedSyncJob };
