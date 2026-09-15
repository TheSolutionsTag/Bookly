const express = require('express');
const pool = require('../db/pool');
const { authenticate, authenticateIfPresent } = require('../middleware/auth');
const { authenticateApiKeyIfPresent, enforceApiKeyResourceScope } = require('../middleware/apiKeyAuth');
const { asyncHandler, NotFoundError, ApiError } = require('../middleware/errors');
const { validateBody, validateQuery } = require('../middleware/validate');
const {
  createAppointmentSchema,
  rescheduleAppointmentSchema,
  addNoteSchema,
  appointmentsQuerySchema,
  createWaitlistEntrySchema,
} = require('../validation/schemas');
const {
  createAppointment,
  cancelAppointment,
  rescheduleAppointment,
  addNoteToAppointment,
} = require('../services/appointmentService');
const { addToWaitlist } = require('../services/waitlistService');

const router = express.Router();

// Every route below runs authenticateApiKeyIfPresent first: a request with
// no key is completely unaffected (original, deliberately-public contract
// preserved); a request WITH a key must be valid/unrevoked and, if the key
// is resource-scoped, must stay within that one resource - enforced by
// enforceApiKeyResourceScope right after, before the service layer (and
// therefore the database) is ever touched.
router.use(authenticateApiKeyIfPresent);

async function resourceIdForAppointment(req) {
  const { rows } = await pool.query('SELECT resource_id FROM appointments WHERE id = $1', [req.params.id]);
  return rows[0] ? rows[0].resource_id : null;
}

router.post(
  '/',
  validateBody(createAppointmentSchema),
  enforceApiKeyResourceScope((req) => req.body.resource_id),
  asyncHandler(async (req, res) => {
    const appointment = await createAppointment(req.body);
    res.status(201).json(appointment);
  })
);

// Standout feature — waitlist. Same public, no-auth contract as the create
// route above (an AI system or a direct customer can both call this), and
// the same resource-scoping discipline for a scoped API key.
router.post(
  '/waitlist',
  validateBody(createWaitlistEntrySchema),
  enforceApiKeyResourceScope((req) => req.body.resource_id),
  asyncHandler(async (req, res) => {
    const entry = await addToWaitlist(req.body);
    res.status(201).json(entry);
  })
);

// Plain email/phone lookup (the "what's the status of my appointment" case)
// is open, matching the AI-facing contract in the spec. Broader queries -
// by resource, status, or date range, with no contact filter - are how the
// staff/admin dashboard lists "upcoming appointments", so those require a
// logged-in user (either role) to avoid exposing every customer's bookings.
function requireAuthForBroadQueries(req, res, next) {
  if (req.query.email || req.query.phone) return next();
  return authenticate(req, res, next);
}

// A scoped key's email/phone lookup must still never surface another
// resource's appointments - the requireAuthForBroadQueries bypass above is
// keyed off "a contact filter was given", not off who's asking, so this
// runs regardless of that bypass and forces resource_id to the key's own
// scope. Rejects outright (rather than silently narrowing) if the caller
// explicitly asked for a different resource_id - that's a scope violation
// worth surfacing loudly, not a query to quietly rewrite.
function forceApiKeyResourceScope(req, res, next) {
  if (!req.apiKey || !req.apiKey.resourceId) return next();
  if (req.query.resource_id && req.query.resource_id !== req.apiKey.resourceId) {
    return next(new ApiError(404, 'NOT_FOUND', 'Not found'));
  }
  req.query.resource_id = req.apiKey.resourceId;
  next();
}

router.get(
  '/',
  requireAuthForBroadQueries,
  forceApiKeyResourceScope,
  validateQuery(appointmentsQuerySchema),
  asyncHandler(async (req, res) => {
    const { email, phone, resource_id, status, from, to, limit } = req.validatedQuery;
    const conditions = [];
    const values = [];
    if (email) {
      values.push(email);
      conditions.push(`customer_email = $${values.length}`);
    }
    if (phone) {
      values.push(phone);
      conditions.push(`customer_phone = $${values.length}`);
    }
    if (resource_id) {
      values.push(resource_id);
      conditions.push(`resource_id = $${values.length}`);
    }
    if (status) {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }
    if (from) {
      values.push(from);
      conditions.push(`start_time >= $${values.length}`);
    }
    if (to) {
      values.push(to);
      conditions.push(`start_time <= $${values.length}`);
    }
    values.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM appointments WHERE ${conditions.join(' AND ')} ORDER BY start_time ASC LIMIT $${values.length}`,
      values
    );
    res.json(rows);
  })
);

router.get(
  '/:id',
  enforceApiKeyResourceScope(resourceIdForAppointment),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
    if (rows.length === 0) throw new NotFoundError(`Appointment ${req.params.id} not found`);
    res.json(rows[0]);
  })
);

router.post(
  '/:id/cancel',
  enforceApiKeyResourceScope(resourceIdForAppointment),
  asyncHandler(async (req, res) => {
    const appointment = await cancelAppointment(req.params.id);
    res.json(appointment);
  })
);

router.post(
  '/:id/reschedule',
  validateBody(rescheduleAppointmentSchema),
  enforceApiKeyResourceScope(resourceIdForAppointment),
  // Optional - never rejects a caller with no/invalid session (the
  // deliberately-public contract stays intact). Only used, when present,
  // to attribute a resource reassignment to a real admin - see
  // appointmentService.js's rescheduleAppointment.
  authenticateIfPresent,
  asyncHandler(async (req, res) => {
    const appointment = await rescheduleAppointment(req.params.id, req.body, req.user || null);
    res.status(201).json(appointment);
  })
);

// Public, same contract as cancel/reschedule above: an unauthenticated
// caller (an AI system) can add a note/attachment to any appointment id it
// knows; a resource-scoped API key is still confined to its own resource
// via the same enforceApiKeyResourceScope helper.
router.post(
  '/:id/notes',
  validateBody(addNoteSchema),
  enforceApiKeyResourceScope(resourceIdForAppointment),
  asyncHandler(async (req, res) => {
    const appointment = await addNoteToAppointment(req.params.id, req.body);
    res.json(appointment);
  })
);

module.exports = router;
