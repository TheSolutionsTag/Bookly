const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const { errorHandler } = require('./middleware/errors');
const resourcesRouter = require('./routes/resources');
const appointmentsRouter = require('./routes/appointments');
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const integrationsRouter = require('./routes/integrations');
const contactRouter = require('./routes/contact');
const webhooksRouter = require('./routes/webhooks');
const apiKeysRouter = require('./routes/apiKeys');
const reportsRouter = require('./routes/reports');

function createApp() {
  const app = express();

  app.use(cors());
  // Captures the raw request body alongside the parsed one - the Calendly
  // webhook signature is computed over the exact raw bytes, which is no
  // longer available once JSON.parse has round-tripped it.
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(pinoHttp({ logger }));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use('/auth', authRouter);
  app.use('/users', usersRouter);
  app.use('/integrations', integrationsRouter);
  app.use('/contact', contactRouter);
  app.use('/webhooks', webhooksRouter);
  app.use('/api-keys', apiKeysRouter);
  app.use('/resources', resourcesRouter);
  app.use('/appointments', appointmentsRouter);
  app.use('/reports', reportsRouter);

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  app.use(errorHandler(logger));

  return app;
}

module.exports = createApp;
