const crypto = require('crypto');
const express = require('express');
const pool = require('../db/pool');
const logger = require('../logger');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler, NotFoundError, ApiError } = require('../middleware/errors');
const { validateBody, validateQuery } = require('../middleware/validate');
const {
  createResourceSchema,
  createAvailabilityRuleSchema,
  createExceptionSchema,
  availableSlotsQuerySchema,
  updateResourceCalendarSchema,
  updateResourceVideoProviderSchema,
  createExternalFeedSchema,
  updateResourceServiceInfoSchema,
} = require('../validation/schemas');
const { computeAvailableSlots } = require('../services/availabilityService');
const { getExternalBusyForDate } = require('../services/appointmentService');
const { listWaitlistForResource } = require('../services/waitlistService');
const icsFeedService = require('../services/icsFeedService');
const icsPublishService = require('../services/icsPublishService');

const router = express.Router();

async function loadResourceOr404(id) {
  const { rows } = await pool.query('SELECT * FROM resources WHERE id = $1', [id]);
  if (rows.length === 0) throw new NotFoundError(`Resource ${id} not found`);
  return rows[0];
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM resources ORDER BY created_at DESC');
    res.json(rows);
  })
);

router.post(
  '/',
  authenticate, requireRole('ADMIN'),
  validateBody(createResourceSchema),
  asyncHandler(async (req, res) => {
    const { name, timezone, slot_duration_minutes } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO resources (name, timezone, slot_duration_minutes, calendar_feed_token)
       VALUES ($1, $2, $3, encode(gen_random_bytes(24), 'hex')) RETURNING *`,
      [name, timezone, slot_duration_minutes]
    );
    logger.info({ resource_id: rows[0].id }, 'Resource created');
    res.status(201).json(rows[0]);
  })
);

// A resource syncs to exactly one calendar provider at a time (or none) -
// switching providers always clears the other provider's calendar id, so
// there's never an ambiguous "which one is authoritative" state.
router.patch(
  '/:id/calendar',
  authenticate, requireRole('ADMIN'),
  validateBody(updateResourceCalendarSchema),
  asyncHandler(async (req, res) => {
    await loadResourceOr404(req.params.id);
    const { provider, calendar_id } = req.body;

    const googleId = provider === 'google' ? calendar_id : null;
    const microsoftId = provider === 'microsoft' ? calendar_id : null;

    const { rows } = await pool.query(
      `UPDATE resources
       SET calendar_provider = $2, google_calendar_id = $3, microsoft_calendar_id = $4
       WHERE id = $1 RETURNING *`,
      [req.params.id, provider === 'none' ? null : provider, googleId, microsoftId]
    );
    logger.info({ resource_id: req.params.id, provider }, 'Resource calendar link updated');
    res.json(rows[0]);
  })
);

// Independent of calendar sync - a resource can generate a Zoom link with
// or without also syncing a calendar. Google Meet is the one exception:
// its link is generated as part of the Google Calendar event itself, so
// it requires the resource to already be synced to Google - checked here,
// at save time, rather than failing silently on every future booking.
router.patch(
  '/:id/video-provider',
  authenticate, requireRole('ADMIN'),
  validateBody(updateResourceVideoProviderSchema),
  asyncHandler(async (req, res) => {
    const resource = await loadResourceOr404(req.params.id);
    if (req.body.provider === 'google_meet' && resource.calendar_provider !== 'google') {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'This resource must be synced to Google Calendar (set that first under Calendar sync) before enabling Google Meet links.'
      );
    }
    const { rows } = await pool.query('UPDATE resources SET video_provider = $2 WHERE id = $1 RETURNING *', [
      req.params.id,
      req.body.provider,
    ]);
    logger.info({ resource_id: req.params.id, video_provider: req.body.provider }, 'Resource video provider updated');
    res.json(rows[0]);
  })
);

// Service catalog (standout feature) - price/description for the one
// service this resource offers. Set here by the admin; read back by the
// public endpoint right below, which ChatMate360's Bookly graph calls
// directly (a real-time read, not a mirrored/stale copy) to answer a
// customer's pricing question mid-conversation - see booklyNodes.ts's new
// pricing_question intent.
router.patch(
  '/:id/service-info',
  authenticate, requireRole('ADMIN'),
  validateBody(updateResourceServiceInfoSchema),
  asyncHandler(async (req, res) => {
    await loadResourceOr404(req.params.id);
    const { rows } = await pool.query(
      `UPDATE resources SET
         price_cents = COALESCE($2, price_cents),
         price_currency = COALESCE($3, price_currency),
         service_description = COALESCE($4, service_description)
       WHERE id = $1 RETURNING *`,
      [req.params.id, req.body.price_cents, req.body.price_currency, req.body.service_description]
    );
    logger.info({ resource_id: req.params.id }, 'Resource service info updated');
    res.json(rows[0]);
  })
);

// Public, no-auth, same contract as GET /:id/available-slots below - an AI
// system or a direct customer can both call this. Deliberately a narrow
// projection (name + pricing/description only), never the full resource
// row - no calendar ids, no internal config leaks through this one.
router.get(
  '/:id/service-info',
  asyncHandler(async (req, res) => {
    const resource = await loadResourceOr404(req.params.id);
    res.json({
      name: resource.name,
      price_cents: resource.price_cents,
      price_currency: resource.price_currency,
      service_description: resource.service_description,
    });
  })
);

// Admin-visible list of who's still waiting for a slot on this resource -
// read-only, no notification-triggering here (that only ever happens
// automatically on a real cancellation, see waitlistService.js).
router.get(
  '/:id/waitlist',
  authenticate, requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    await loadResourceOr404(req.params.id);
    const entries = await listWaitlistForResource(req.params.id);
    res.json(entries);
  })
);

router.get(
  '/:id/availability-rules',
  asyncHandler(async (req, res) => {
    await loadResourceOr404(req.params.id);
    const { rows } = await pool.query(
      'SELECT * FROM availability_rules WHERE resource_id = $1 ORDER BY day_of_week, start_time',
      [req.params.id]
    );
    res.json(rows);
  })
);

router.post(
  '/:id/availability-rules',
  authenticate, requireRole('ADMIN'),
  validateBody(createAvailabilityRuleSchema),
  asyncHandler(async (req, res) => {
    await loadResourceOr404(req.params.id);
    const { day_of_week, start_time, end_time, break_start, break_end } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO availability_rules
         (resource_id, day_of_week, start_time, end_time, break_start, break_end)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.id, day_of_week, start_time, end_time, break_start || null, break_end || null]
    );
    res.status(201).json(rows[0]);
  })
);

router.post(
  '/:id/exceptions',
  authenticate, requireRole('ADMIN'),
  validateBody(createExceptionSchema),
  asyncHandler(async (req, res) => {
    await loadResourceOr404(req.params.id);
    const { date, is_closed, reason } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO availability_exceptions (resource_id, date, is_closed, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (resource_id, date) DO UPDATE SET is_closed = $3, reason = $4
       RETURNING *`,
      [req.params.id, date, is_closed, reason || null]
    );
    logger.info({ resource_id: req.params.id, date }, 'Availability exception set');
    res.status(201).json(rows[0]);
  })
);

router.get(
  '/:id/available-slots',
  validateQuery(availableSlotsQuerySchema),
  asyncHandler(async (req, res) => {
    const resource = await loadResourceOr404(req.params.id);
    const { date, duration } = req.validatedQuery;
    const durationMinutes = duration || resource.slot_duration_minutes;

    const [rulesRes, exceptionRes, bookingsRes, externalBusy] = await Promise.all([
      pool.query('SELECT * FROM availability_rules WHERE resource_id = $1', [resource.id]),
      pool.query('SELECT * FROM availability_exceptions WHERE resource_id = $1 AND date = $2', [
        resource.id,
        date,
      ]),
      pool.query(
        `SELECT start_time, end_time FROM appointments
         WHERE resource_id = $1 AND status = 'CONFIRMED'
           AND start_time::date - $2::date BETWEEN -1 AND 1`,
        [resource.id, date]
      ),
      getExternalBusyForDate(resource, date),
    ]);

    const availableSlots = computeAvailableSlots({
      resource,
      date,
      durationMinutes,
      rules: rulesRes.rows,
      exception: exceptionRes.rows[0] || null,
      bookedAppointments: [...bookingsRes.rows, ...externalBusy],
    });

    res.json({
      resource_id: resource.id,
      date,
      duration_minutes: durationMinutes,
      available_slots: availableSlots,
    });
  })
);

// === Generic ICS feed subscriptions (pull busy time from any platform) ===

router.post(
  '/:id/external-feeds',
  authenticate, requireRole('ADMIN'),
  validateBody(createExternalFeedSchema),
  asyncHandler(async (req, res) => {
    await loadResourceOr404(req.params.id);
    const { ics_url, label } = req.body;

    // Fail fast with a clear error rather than saving a feed that was
    // never going to produce data.
    await icsFeedService.validateFeedUrl(ics_url);

    const { rows } = await pool.query(
      `INSERT INTO external_calendar_feeds (resource_id, ics_url, label) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, ics_url, label]
    );
    const feed = rows[0];

    // Do the first sync immediately so the feed has busy data right away,
    // instead of waiting for the next periodic run.
    await icsFeedService.syncFeed(feed);
    const { rows: refreshed } = await pool.query('SELECT * FROM external_calendar_feeds WHERE id = $1', [feed.id]);

    logger.info({ resource_id: req.params.id, feed_id: feed.id, label }, 'External calendar feed added');
    res.status(201).json(refreshed[0]);
  })
);

router.get(
  '/:id/external-feeds',
  asyncHandler(async (req, res) => {
    await loadResourceOr404(req.params.id);
    const { rows } = await pool.query(
      'SELECT * FROM external_calendar_feeds WHERE resource_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(rows);
  })
);

router.delete(
  '/:id/external-feeds/:feedId',
  authenticate, requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    await loadResourceOr404(req.params.id);
    const { rows } = await pool.query(
      'DELETE FROM external_calendar_feeds WHERE id = $1 AND resource_id = $2 RETURNING id',
      [req.params.feedId, req.params.id]
    );
    if (rows.length === 0) throw new NotFoundError(`Feed ${req.params.feedId} not found on this resource`);
    logger.info({ resource_id: req.params.id, feed_id: req.params.feedId }, 'External calendar feed removed');
    res.status(204).end();
  })
);

// === Publishing Bookly's own bookings as a subscribable ICS feed =========

router.get(
  '/:id/calendar.ics',
  asyncHandler(async (req, res) => {
    const resource = await loadResourceOr404(req.params.id);
    const token = String(req.query.token || '');
    if (!resource.calendar_feed_token || !token || token !== resource.calendar_feed_token) {
      throw new ApiError(403, 'FORBIDDEN', 'Invalid or missing calendar feed token');
    }

    const { rows: appointments } = await pool.query(
      `SELECT * FROM appointments
       WHERE resource_id = $1 AND status = 'CONFIRMED' AND end_time > now()
       ORDER BY start_time ASC`,
      [resource.id]
    );

    const ics = icsPublishService.generateResourceIcs(resource, appointments);
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.send(ics);
  })
);

router.post(
  '/:id/calendar-feed/regenerate-token',
  authenticate, requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    await loadResourceOr404(req.params.id);
    const { rows } = await pool.query(
      `UPDATE resources SET calendar_feed_token = encode(gen_random_bytes(24), 'hex') WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    logger.info({ resource_id: req.params.id }, 'Calendar feed token regenerated');
    res.json(rows[0]);
  })
);

module.exports = router;
