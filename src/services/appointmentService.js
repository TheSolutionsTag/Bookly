const { DateTime } = require('luxon');
const pool = require('../db/pool');
const logger = require('../logger');
const { computeAvailableSlots } = require('./availabilityService');
const googleCalendar = require('./googleCalendarService');
const microsoftCalendar = require('./microsoftCalendarService');
const zoomService = require('./zoomService');
const icsFeedService = require('./icsFeedService');
const calendlyWebhookService = require('./calendlyWebhookService');
const emailService = require('./emailService');
const waitlistService = require('./waitlistService');
const { NotFoundError, ConflictError, ApiError } = require('../middleware/errors');

const EXCLUSION_VIOLATION = '23P01'; // Postgres error code for EXCLUDE constraint conflicts

function resolveTimeRange({ start_time, duration, end_time }) {
  const start = DateTime.fromISO(start_time, { setZone: true });
  if (!start.isValid) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Invalid start_time: ${start.invalidExplanation}`);
  }
  const end = end_time ? DateTime.fromISO(end_time, { setZone: true }) : start.plus({ minutes: duration });
  if (!end.isValid) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Invalid end_time: ${end.invalidExplanation}`);
  }
  if (end <= start) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'end_time must be after start_time');
  }
  return { start, end };
}

async function getResourceOr404(client, resourceId) {
  const { rows } = await client.query('SELECT * FROM resources WHERE id = $1', [resourceId]);
  if (rows.length === 0) throw new NotFoundError(`Resource ${resourceId} not found`);
  return rows[0];
}

/**
 * Re-derives whether [start, end) is actually free for a resource, using the
 * same rules/exceptions/bookings the read-side available-slots endpoint
 * uses. This is a server-side re-check, never trusting that a slot a caller
 * saw earlier is still free.
 */
async function isRangeAvailable(client, resource, start, end) {
  const dateKey = start.setZone(resource.timezone).toISODate();

  // Sequential, not Promise.all: these all share one checked-out client
  // (so reschedule can run them inside its transaction), and a single pg
  // Client can't run overlapping queries concurrently.
  const rulesRes = await client.query('SELECT * FROM availability_rules WHERE resource_id = $1', [resource.id]);
  const exceptionRes = await client.query(
    'SELECT * FROM availability_exceptions WHERE resource_id = $1 AND date = $2',
    [resource.id, dateKey]
  );
  const bookingsRes = await client.query(
    `SELECT start_time, end_time FROM appointments
     WHERE resource_id = $1 AND status = 'CONFIRMED'
       AND tstzrange(start_time, end_time) && tstzrange($2::timestamptz, $3::timestamptz)`,
    [resource.id, start.toISO(), end.toISO()]
  );

  const externalBusy = await getExternalBusyForDate(resource, dateKey);

  const durationMinutes = Math.round(end.diff(start, 'minutes').minutes);
  const availableSlots = computeAvailableSlots({
    resource,
    date: dateKey,
    durationMinutes,
    rules: rulesRes.rows,
    exception: exceptionRes.rows[0] || null,
    bookedAppointments: [...bookingsRes.rows, ...externalBusy],
  });

  return availableSlots.includes(start.toUTC().toISO());
}

/**
 * Busy ranges from the resource's connected Google Calendar for its whole
 * local day (so they line up with how computeAvailableSlots windows a
 * day), or [] if the resource isn't linked to a calendar. Never throws -
 * a Google outage should degrade to "no extra info", not break booking.
 */
async function getGoogleBusyForDate(resource, dateKey) {
  if (!resource.google_calendar_id) return [];
  const dayStart = DateTime.fromISO(dateKey, { zone: resource.timezone }).startOf('day');
  const dayEnd = dayStart.plus({ days: 1 });
  return googleCalendar.getBusyRanges(resource.google_calendar_id, dayStart.toUTC().toISO(), dayEnd.toUTC().toISO());
}

/** Same shape as getGoogleBusyForDate, for a resource linked to Microsoft. */
async function getMicrosoftBusyForDate(resource, dateKey) {
  if (!resource.microsoft_calendar_id) return [];
  const dayStart = DateTime.fromISO(dateKey, { zone: resource.timezone }).startOf('day');
  const dayEnd = dayStart.plus({ days: 1 });
  return microsoftCalendar.getBusyRanges(
    resource.microsoft_calendar_id,
    dayStart.toUTC().toISO(),
    dayEnd.toUTC().toISO()
  );
}

/**
 * The single source of truth for "what external busy time exists for this
 * resource on this day", merging every provider a resource might be using
 * at once: its one calendar-sync provider (Google or Microsoft, mutually
 * exclusive), any number of subscribed ICS feeds (Calendly, Acuity, Apple
 * Calendar, etc.), and any Calendly-webhook-driven busy blocks. Every
 * source degrades to [] on its own failure, so one flaky integration never
 * takes down availability for the rest.
 */
async function getExternalBusyForDate(resource, dateKey) {
  const dayStart = DateTime.fromISO(dateKey, { zone: resource.timezone }).startOf('day');
  const dayEnd = dayStart.plus({ days: 1 });
  const timeMinIso = dayStart.toUTC().toISO();
  const timeMaxIso = dayEnd.toUTC().toISO();

  const [google, microsoft, feeds, calendly] = await Promise.all([
    getGoogleBusyForDate(resource, dateKey),
    getMicrosoftBusyForDate(resource, dateKey),
    icsFeedService.getFeedBusyForResource(resource.id, timeMinIso, timeMaxIso).catch((err) => {
      logger.warn({ err: err.message, resource_id: resource.id }, 'ICS feed busy lookup failed, ignoring');
      return [];
    }),
    calendlyWebhookService.getCalendlyBusyForResource(resource.id, timeMinIso, timeMaxIso).catch((err) => {
      logger.warn({ err: err.message, resource_id: resource.id }, 'Calendly busy lookup failed, ignoring');
      return [];
    }),
  ]);

  return [...google, ...microsoft, ...feeds, ...calendly];
}

async function createAppointment(input) {
  const client = await pool.connect();
  let resource, created;
  try {
    resource = await getResourceOr404(client, input.resource_id);
    const { start, end } = resolveTimeRange(input);

    const available = await isRangeAvailable(client, resource, start, end);
    if (!available) {
      logger.warn(
        { resource_id: resource.id, start_time: start.toISO() },
        'Booking rejected: requested slot is not available'
      );
      throw new ConflictError('That slot is not available.');
    }

    try {
      const { rows } = await client.query(
        `INSERT INTO appointments
           (resource_id, customer_name, customer_email, customer_phone, start_time, end_time, notes, attachment_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          resource.id,
          input.customer_name,
          input.customer_email,
          input.customer_phone || null,
          start.toISO(),
          end.toISO(),
          input.notes || null,
          input.attachment_url || null,
        ]
      );
      created = rows[0];
      logger.info({ appointment_id: created.id, resource_id: resource.id }, 'Appointment created');
    } catch (err) {
      if (err.code === EXCLUSION_VIOLATION) {
        logger.warn(
          { resource_id: resource.id, start_time: start.toISO() },
          'Booking rejected: slot taken concurrently (exclusion constraint)'
        );
        throw new ConflictError('That slot was just taken.');
      }
      throw err;
    }
  } finally {
    client.release();
  }

  // Best-effort, outside the pooled connection: a slow or failing external
  // call must never hold a connection open or roll back a real booking.
  return syncNewAppointmentExternal(resource, created);
}

/**
 * If the resource is linked to a Google Calendar, creates a matching event
 * and stores its ID on the appointment - and, if the resource's video
 * provider is 'google_meet', asks Google to attach a real Meet link to
 * that same event and stores the join URL too. Failure at any point just
 * leaves google_event_id/google_meet_url null - the booking itself has
 * already succeeded and must stay that way.
 */
async function syncNewAppointmentToGoogle(resource, appointment) {
  if (!resource.google_calendar_id) return appointment;
  const wantsMeetLink = resource.video_provider === 'google_meet';
  const result = await googleCalendar.createEvent(resource.google_calendar_id, appointment, {
    generateMeetLink: wantsMeetLink,
  });
  if (!result) return appointment;
  const { rows } = await pool.query(
    'UPDATE appointments SET google_event_id = $2, google_meet_url = $3 WHERE id = $1 RETURNING *',
    [appointment.id, result.eventId, result.meetUrl]
  );
  return rows[0];
}

/** Same shape as syncNewAppointmentToGoogle, for a resource linked to Microsoft. */
async function syncNewAppointmentToMicrosoft(resource, appointment) {
  if (!resource.microsoft_calendar_id) return appointment;
  const eventId = await microsoftCalendar.createEvent(resource.microsoft_calendar_id, appointment);
  if (!eventId) return appointment;
  const { rows } = await pool.query('UPDATE appointments SET microsoft_event_id = $2 WHERE id = $1 RETURNING *', [
    appointment.id,
    eventId,
  ]);
  return rows[0];
}

/**
 * If the resource has Zoom enabled as its video provider, creates a
 * meeting and stores the join URL/meeting ID. Independent of whichever
 * calendar provider (if any) the resource syncs to. Failure just leaves
 * zoom_join_url null - same resilience rule as calendar sync.
 */
async function syncNewAppointmentToZoom(resource, appointment) {
  if (resource.video_provider !== 'zoom') return appointment;
  const meeting = await zoomService.createMeeting(appointment);
  if (!meeting) return appointment;
  const { rows } = await pool.query(
    'UPDATE appointments SET zoom_meeting_id = $2, zoom_join_url = $3 WHERE id = $1 RETURNING *',
    [appointment.id, meeting.meetingId, meeting.joinUrl]
  );
  return rows[0];
}

/**
 * Runs every applicable push-sync for a newly-created appointment: its one
 * calendar provider (Google or Microsoft, mutually exclusive by how
 * PATCH /resources/:id/calendar maintains the columns) and, independently,
 * Zoom meeting generation. Each step is already individually best-effort;
 * chaining them just means each sees the appointment row as updated by
 * the one before it.
 */
async function syncNewAppointmentExternal(resource, appointment, emailKind = 'booking') {
  let result = await syncNewAppointmentToGoogle(resource, appointment);
  result = await syncNewAppointmentToMicrosoft(resource, result);
  result = await syncNewAppointmentToZoom(resource, result);
  // Real transactional email (emailService.js) - best-effort, same as
  // every sync step above; never throws, so a missing/misconfigured email
  // provider can never fail a real booking. Sent AFTER the calendar/video
  // syncs above so a real join link, if one was generated, is included.
  if (emailKind === 'reschedule') {
    await emailService.sendRescheduleEmail(result, resource.name);
  } else {
    await emailService.sendBookingConfirmationEmail(result, resource.name);
  }
  return result;
}

/**
 * The ONLY code path allowed to change appointments.status. Keeping every
 * status transition here (rather than inline UPDATEs scattered across
 * routes) means adding new states later only touches this file.
 */
async function setAppointmentStatus(client, id, status, extraFields = {}) {
  const fields = ['status = $2', ...Object.keys(extraFields).map((k, i) => `${k} = $${i + 3}`)];
  const values = [id, status, ...Object.values(extraFields)];
  const { rows } = await client.query(
    `UPDATE appointments SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  if (rows.length === 0) throw new NotFoundError(`Appointment ${id} not found`);
  return rows[0];
}

async function cancelAppointment(id) {
  const client = await pool.connect();
  let updated, resource;
  try {
    const { rows } = await client.query('SELECT * FROM appointments WHERE id = $1', [id]);
    if (rows.length === 0) throw new NotFoundError(`Appointment ${id} not found`);
    if (rows[0].status === 'CANCELLED') {
      return rows[0]; // already cancelled - idempotent
    }
    updated = await setAppointmentStatus(client, id, 'CANCELLED', { cancelled_at: new Date().toISOString() });
    resource = await getResourceOr404(client, updated.resource_id);
    logger.info({ appointment_id: id }, 'Appointment cancelled');
  } finally {
    client.release();
  }

  await deleteExternalArtifactsForAppointment(resource, updated);
  await emailService.sendCancellationEmail(updated, resource.name);
  // Standout feature — automatic waitlist: freeing up this exact
  // resource/date might be exactly what someone already asked to be
  // notified about. Best-effort, same discipline as every sync/email call
  // in this file - never lets a waitlist-notification failure affect the
  // cancellation that already genuinely succeeded above.
  await waitlistService.notifyWaitlistForFreedSlot(resource, updated);
  return updated;
}

/**
 * Tears down whatever external artifacts an appointment accumulated
 * (a Google or Microsoft calendar event, a Zoom meeting) - used on both
 * cancel and reschedule (where the old appointment is cancelled). Every
 * step is independently best-effort.
 */
async function deleteExternalArtifactsForAppointment(resource, appointment) {
  if (resource.google_calendar_id && appointment.google_event_id) {
    await googleCalendar.deleteEvent(resource.google_calendar_id, appointment.google_event_id);
  }
  if (resource.microsoft_calendar_id && appointment.microsoft_event_id) {
    await microsoftCalendar.deleteEvent(resource.microsoft_calendar_id, appointment.microsoft_event_id);
  }
  if (appointment.zoom_meeting_id) {
    await zoomService.deleteMeeting(appointment.zoom_meeting_id);
  }
}

/**
 * Appends a free-text note and/or sets the bot-collected attachment link on
 * an existing CONFIRMED appointment - the mid-conversation "add a note to
 * this meeting" action, distinct from the notes/attachment_url a customer
 * can already supply at booking time (createAppointment above). Appends to
 * any existing note text (never overwrites it) and re-syncs the resource's
 * Google Calendar event description, if one exists, so the two stay in
 * sync - a Calendar sync failure never fails the note-saving itself (see
 * googleCalendarService.updateEventDescription's own resilience).
 */
async function addNoteToAppointment(id, { note, attachment_url } = {}) {
  const { rows } = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
  if (rows.length === 0) throw new NotFoundError(`Appointment ${id} not found`);
  const existing = rows[0];
  if (existing.status === 'CANCELLED') {
    throw new ApiError(409, 'CONFLICT', 'Cannot add a note to a cancelled appointment');
  }

  const mergedNotes = note ? (existing.notes ? `${existing.notes}\n${note}` : note) : existing.notes;
  const mergedAttachmentUrl = attachment_url || existing.attachment_url;

  const { rows: updatedRows } = await pool.query(
    'UPDATE appointments SET notes = $2, attachment_url = $3 WHERE id = $1 RETURNING *',
    [id, mergedNotes, mergedAttachmentUrl]
  );
  const updated = updatedRows[0];
  logger.info({ appointment_id: id }, 'Note added to appointment');

  // Best-effort, same "never block on an external call" discipline as
  // createAppointment/rescheduleAppointment's own external syncs.
  if (updated.google_event_id) {
    const resource = await getResourceOr404(pool, updated.resource_id);
    if (resource.google_calendar_id) {
      await googleCalendar.updateEventDescription(resource.google_calendar_id, updated.google_event_id, updated);
    }
  }

  return updated;
}

async function rescheduleAppointment(id, input, actor = null) {
  const client = await pool.connect();
  let resource, existing, created;
  try {
    await client.query('BEGIN');

    const existingRes = await client.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id]);
    if (existingRes.rows.length === 0) throw new NotFoundError(`Appointment ${id} not found`);
    existing = existingRes.rows[0];
    if (existing.status !== 'CONFIRMED') {
      throw new ApiError(409, 'CONFLICT', 'Only confirmed appointments can be rescheduled');
    }

    // A resource reassignment (moving to a DIFFERENT resource, not just a
    // new time) - input.resource_id is only ever populated by
    // ChatMate360's admin-chat tool set (see validation/schemas.js's
    // rescheduleAppointmentSchema comment); an ordinary customer
    // reschedule never sends it, so newResourceId === existing.resource_id
    // and every branch below is a no-op for that case.
    const newResourceId = input.resource_id || existing.resource_id;
    const isReassignment = newResourceId !== existing.resource_id;
    resource = await getResourceOr404(client, newResourceId);
    const { start, end } = resolveTimeRange(input);

    // Cancel the old appointment first so it stops occupying its slot in the
    // exclusion constraint's view, then availability-check + insert the new
    // one - all inside this single transaction. Never a bare UPDATE of
    // start_time, so the exclusion constraint always protects the new slot.
    await setAppointmentStatus(client, id, 'CANCELLED', {
      cancelled_at: new Date().toISOString(),
      cancellation_reason: isReassignment
        ? `Reassigned to a different resource by ${actor?.name || 'an admin'}`
        : null,
    });

    const available = await isRangeAvailable(client, resource, start, end);
    if (!available) {
      throw new ConflictError('That new slot is not available.');
    }

    try {
      const { rows } = await client.query(
        `INSERT INTO appointments
           (resource_id, customer_name, customer_email, customer_phone, start_time, end_time, notes, attachment_url, reassigned_from_resource_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          newResourceId,
          existing.customer_name,
          existing.customer_email,
          existing.customer_phone,
          start.toISO(),
          end.toISO(),
          existing.notes,
          existing.attachment_url,
          isReassignment ? existing.resource_id : null,
        ]
      );
      created = rows[0];
    } catch (err) {
      if (err.code === EXCLUSION_VIOLATION) {
        throw new ConflictError('That new slot was just taken.');
      }
      throw err;
    }

    await client.query('COMMIT');
    logger.info(
      { old_appointment_id: id, new_appointment_id: created.id, reassigned: isReassignment },
      'Appointment rescheduled'
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Best-effort, outside the pooled connection, same reasoning as
  // createAppointment: never hold a connection open for an external call.
  await deleteExternalArtifactsForAppointment(resource, existing);
  return syncNewAppointmentExternal(resource, created, 'reschedule');
}

module.exports = {
  createAppointment,
  cancelAppointment,
  rescheduleAppointment,
  addNoteToAppointment,
  isRangeAvailable,
  resolveTimeRange,
  getGoogleBusyForDate,
  getExternalBusyForDate,
};
