const express = require('express');
const logger = require('../logger');
const { asyncHandler, ApiError } = require('../middleware/errors');
const calendlyWebhookService = require('../services/calendlyWebhookService');
const pool = require('../db/pool');

const router = express.Router();

async function resourceExists(resourceId) {
  const { rows } = await pool.query('SELECT id FROM resources WHERE id = $1', [resourceId]);
  return rows.length > 0;
}

// Public (Calendly calls this directly) - trust comes entirely from the
// signature check below, not from auth middleware. This is a busy-time
// signal only: Bookly cannot create, modify, or cancel a Calendly booking
// through this endpoint, since Calendly has no API for that. See the
// README for that limitation.
router.post(
  '/calendly/:resourceId',
  asyncHandler(async (req, res) => {
    const signatureHeader = req.header('Calendly-Webhook-Signature');
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);

    if (!calendlyWebhookService.verifySignature(signatureHeader, rawBody)) {
      logger.warn({ resource_id: req.params.resourceId }, 'Calendly webhook rejected: bad signature');
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid webhook signature');
    }

    if (!(await resourceExists(req.params.resourceId))) {
      throw new ApiError(404, 'NOT_FOUND', `Resource ${req.params.resourceId} not found`);
    }

    const { event, payload } = req.body;

    if (event === 'invitee.created') {
      await calendlyWebhookService.handleInviteeCreated(req.params.resourceId, payload);
    } else if (event === 'invitee.canceled') {
      await calendlyWebhookService.handleInviteeCanceled(payload);
    } else {
      logger.info({ event }, 'Calendly webhook: ignoring unhandled event type');
    }

    res.status(200).json({ received: true });
  })
);

module.exports = router;
