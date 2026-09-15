const config = require('../config');
const logger = require('../logger');
const reminderService = require('../services/reminderService');

/**
 * Starts the periodic appointment-reminder job (interval configurable via
 * REMINDER_CHECK_INTERVAL_MINUTES, default 15; lead time via
 * REMINDER_LEAD_HOURS, default 24). Same shape as jobs/icsFeedSync.js's
 * own job - deliberately not started by app.js/createApp() so tests build
 * the app directly without a live timer running in the background.
 */
function startReminderJob() {
  const intervalMs = config.reminderCheckIntervalMinutes * 60_000;

  async function runOnce() {
    try {
      const count = await reminderService.sendDueReminders();
      if (count > 0) {
        logger.info({ reminder_count: count }, 'Periodic reminder check completed');
      }
    } catch (err) {
      // Should be unreachable (sendDueReminders' own per-appointment send
      // is best-effort), but a check run must never crash the process.
      logger.error({ err }, 'Periodic reminder check failed unexpectedly');
    }
  }

  logger.info({ interval_minutes: config.reminderCheckIntervalMinutes, lead_hours: config.reminderLeadHours }, 'Starting reminder job');
  runOnce();
  return setInterval(runOnce, intervalMs);
}

module.exports = { startReminderJob };
