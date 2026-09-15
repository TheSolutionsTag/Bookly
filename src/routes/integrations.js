const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../logger');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler, ApiError } = require('../middleware/errors');
const googleCalendar = require('../services/googleCalendarService');
const microsoftCalendar = require('../services/microsoftCalendarService');
const zoomService = require('../services/zoomService');

const router = express.Router();

// The OAuth dance is a full browser redirect (provider -> our callback), so
// there's no Authorization header to check on the callback itself. Instead,
// the ADMIN-gated "connect-url" endpoint signs a short-lived state token
// carrying the initiating admin's id; the callback verifies that signature
// before trusting the request, which also doubles as CSRF protection.
// Shared across every OAuth provider (Google, Microsoft, Zoom).
function signState(provider, userId) {
  return jwt.sign({ sub: userId, purpose: `${provider}-oauth-state` }, config.jwtSecret, { expiresIn: '10m' });
}

function verifyState(provider, state) {
  const payload = jwt.verify(state, config.jwtSecret);
  if (payload.purpose !== `${provider}-oauth-state`) throw new Error('Invalid state token');
  return payload.sub;
}

function registerProviderRoutes(path, label, service) {
  router.get(
    `/${path}/connect-url`,
    authenticate,
    requireRole('ADMIN'),
    asyncHandler(async (req, res) => {
      if (!service.isConfigured()) {
        throw new ApiError(
          503,
          'NOT_CONFIGURED',
          `${label} integration is not configured on this server (missing credentials in .env).`
        );
      }
      const url = service.getAuthUrl(signState(path, req.user.id));
      res.json({ url });
    })
  );

  // Public: this is the redirect target the provider itself sends the
  // browser to. Trust comes entirely from verifying `state`, not a session.
  router.get(
    `/${path}/callback`,
    asyncHandler(async (req, res) => {
      const { code, state, error } = req.query;
      const redirectBase = `${config.frontendUrl}/integrations`;

      if (error) {
        return res.redirect(`${redirectBase}?${path}_error=${encodeURIComponent(String(error))}`);
      }

      let userId;
      try {
        userId = verifyState(path, String(state || ''));
      } catch (err) {
        logger.warn({ err: err.message, path }, `${label} OAuth callback rejected: bad state token`);
        return res.redirect(`${redirectBase}?${path}_error=invalid_state`);
      }

      try {
        await service.handleOAuthCallback(String(code), userId);
        return res.redirect(`${redirectBase}?${path}_connected=1`);
      } catch (err) {
        logger.error({ err }, `${label} OAuth callback failed`);
        return res.redirect(`${redirectBase}?${path}_error=exchange_failed`);
      }
    })
  );

  router.get(
    `/${path}/status`,
    authenticate,
    requireRole('ADMIN'),
    asyncHandler(async (req, res) => {
      const status = await service.getStatus();
      res.json({
        configured: service.isConfigured(),
        connected: Boolean(status),
        account_email: status?.account_email || null,
        connected_at: status?.connected_at || null,
      });
    })
  );

  router.post(
    `/${path}/disconnect`,
    authenticate,
    requireRole('ADMIN'),
    asyncHandler(async (req, res) => {
      await service.disconnect();
      res.json({ disconnected: true });
    })
  );
}

registerProviderRoutes('google', 'Google Calendar', googleCalendar);
registerProviderRoutes('microsoft', 'Microsoft Calendar', microsoftCalendar);
registerProviderRoutes('zoom', 'Zoom', zoomService);

module.exports = router;
