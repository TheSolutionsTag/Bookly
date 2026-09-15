const createApp = require('./app');
const config = require('./config');
const logger = require('./logger');
const { startIcsFeedSyncJob } = require('./jobs/icsFeedSync');
const { startReminderJob } = require('./jobs/reminderJob');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`Bookly API listening on port ${config.port}`);
});

startIcsFeedSyncJob();
startReminderJob();

// Fail fast and loud instead of hanging requests indefinitely.
server.requestTimeout = 30_000;
server.headersTimeout = 31_000;

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});
