const crypto = require('crypto');
const pool = require('../db/pool');
const logger = require('../logger');
const config = require('../config');

/**
 * Verifies Calendly's v2 webhook signature. Header shape is
 * "t=<timestamp>,v1=<hex hmac>"; the signed payload is "<timestamp>.<rawBody>",
 * HMAC-SHA256'd with the webhook's signing key. Returns false (never
 * throws) on any malformed header or missing config, so callers can
 * uniformly reject.
 */
function verifySignature(signatureHeader, rawBody) {
  if (!config.calendly.webhookSigningKey || !signatureHeader) return false;

  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(',')
      .map((part) => part.split('=').map((s) => s.trim()))
  );
  const timestamp = parts.t;
  const providedSignature = parts.v1;
  if (!timestamp || !providedSignature) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', config.calendly.webhookSigningKey)
    .update(signedPayload)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(providedSignature, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * invitee.created -> add a busy block for the resource. Upserts on the
 * Calendly event's own URI so a duplicate delivery doesn't create two
 * blocks for the same event.
 */
async function handleInviteeCreated(resourceId, payload) {
  const event = payload?.scheduled_event;
  if (!event?.uri || !event?.start_time || !event?.end_time) {
    throw new Error('Webhook payload missing scheduled_event start_time/end_time');
  }

  await pool.query(
    `INSERT INTO calendly_busy_blocks (resource_id, calendly_event_uri, start_time, end_time)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (calendly_event_uri) DO UPDATE SET start_time = $3, end_time = $4`,
    [resourceId, event.uri, event.start_time, event.end_time]
  );
  logger.info({ resource_id: resourceId, calendly_event_uri: event.uri }, 'Calendly busy block added');
}

/** invitee.canceled -> remove the matching busy block, if any. */
async function handleInviteeCanceled(payload) {
  const event = payload?.scheduled_event;
  if (!event?.uri) {
    throw new Error('Webhook payload missing scheduled_event uri');
  }
  await pool.query('DELETE FROM calendly_busy_blocks WHERE calendly_event_uri = $1', [event.uri]);
  logger.info({ calendly_event_uri: event.uri }, 'Calendly busy block removed');
}

async function getCalendlyBusyForResource(resourceId, timeMinIso, timeMaxIso) {
  const { rows } = await pool.query(
    `SELECT start_time, end_time FROM calendly_busy_blocks
     WHERE resource_id = $1
       AND tstzrange(start_time, end_time) && tstzrange($2::timestamptz, $3::timestamptz)`,
    [resourceId, timeMinIso, timeMaxIso]
  );
  return rows;
}

module.exports = { verifySignature, handleInviteeCreated, handleInviteeCanceled, getCalendlyBusyForResource };
