const pino = require('pino');
const config = require('./config');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // pino-http (app.js) logs the full request/response by default,
  // Authorization header included - without this, every API-key-
  // authenticated request (middleware/apiKeyAuth.js) would print the raw
  // Bearer key in plaintext on every request log line. Also covers the
  // JWT bearer token staff/admin routes use on this same header, and any
  // future body/query field literally named api_key/apiKey/token.
  redact: {
    paths: ['req.headers.authorization', '*.api_key', '*.apiKey', '*.token'],
    censor: '[redacted]',
  },
  transport:
    config.nodeEnv === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});

module.exports = logger;
