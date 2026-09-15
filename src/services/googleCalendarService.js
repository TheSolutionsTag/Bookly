const { google } = require('googleapis');
const pool = require('../db/pool');
const logger = require('../logger');
const config = require('../config');

const PROVIDER = 'google';
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/userinfo.email'];

function newOAuthClient() {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

function isConfigured() {
  return Boolean(config.google.clientId && config.google.clientSecret && config.google.redirectUri);
}

function getAuthUrl(state) {
  const client = newOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline', // required to get a refresh_token
    prompt: 'consent', // force a refresh_token even on repeat connects
    scope: SCOPES,
    state,
  });
}

async function handleOAuthCallback(code, connectedByUserId) {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ auth: client, version: 'v2' });
  const { data: profile } = await oauth2.userinfo.get();

  await pool.query(
    `INSERT INTO integrations (provider, access_token, refresh_token, expires_at, account_email, connected_by, connected_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (provider) DO UPDATE SET
       access_token = $2,
       refresh_token = COALESCE($3, integrations.refresh_token),
       expires_at = $4,
       account_email = $5,
       connected_by = $6,
       connected_at = now()`,
    [
      PROVIDER,
      tokens.access_token,
      tokens.refresh_token || null,
      tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      profile.email,
      connectedByUserId,
    ]
  );

  logger.info({ email: profile.email }, 'Google Calendar connected');
  return profile.email;
}

async function getStatus() {
  const { rows } = await pool.query('SELECT provider, account_email, connected_at FROM integrations WHERE provider = $1', [
    PROVIDER,
  ]);
  return rows[0] || null;
}

async function disconnect() {
  await pool.query('DELETE FROM integrations WHERE provider = $1', [PROVIDER]);
  logger.info('Google Calendar disconnected');
}

/**
 * Returns an authenticated googleapis client for Calendar API calls, or
 * null if nothing is connected. Handles refreshing the access token and
 * persisting the new one, transparently.
 */
async function getAuthedClient() {
  const { rows } = await pool.query('SELECT * FROM integrations WHERE provider = $1', [PROVIDER]);
  const record = rows[0];
  if (!record) return null;

  const client = newOAuthClient();
  client.setCredentials({
    access_token: record.access_token,
    refresh_token: record.refresh_token,
    expiry_date: record.expires_at ? new Date(record.expires_at).getTime() : undefined,
  });

  client.on('tokens', async (tokens) => {
    // googleapis fires this whenever it silently refreshes the access token.
    await pool.query(
      `UPDATE integrations SET access_token = $2, expires_at = $3, refresh_token = COALESCE($4, refresh_token)
       WHERE provider = $1`,
      [
        PROVIDER,
        tokens.access_token,
        tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        tokens.refresh_token || null,
      ]
    );
  });

  return client;
}

/**
 * Busy time ranges (UTC ISO instants) from the given calendar over
 * [timeMin, timeMax], via the Freebusy API. Returns [] if nothing is
 * connected, or on any API error (never blocks availability on a Google
 * outage - it just stops contributing extra constraints).
 */
async function getBusyRanges(calendarId, timeMinIso, timeMaxIso) {
  try {
    const auth = await getAuthedClient();
    if (!auth) return [];
    const calendar = google.calendar({ version: 'v3', auth });
    const { data } = await calendar.freebusy.query({
      requestBody: { timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: calendarId || 'primary' }] },
    });
    const busy = data.calendars?.[calendarId || 'primary']?.busy || [];
    return busy.map((b) => ({ start_time: b.start, end_time: b.end }));
  } catch (err) {
    logger.warn({ err: err.message, calendarId }, 'Google freebusy lookup failed, ignoring');
    return [];
  }
}

/**
 * The event description for an appointment: its notes plus, if present, a
 * plain-text link to the bot-collected attachment URL (never a native
 * Calendar `attachments` entry - see db/schema.sql's comment on why: that
 * would need Drive API scopes this integration was never granted). Shared
 * by createEvent and updateEventDescription so both stay in sync.
 */
function buildDescription(appointment) {
  const parts = [];
  if (appointment.notes) parts.push(appointment.notes);
  if (appointment.attachment_url) parts.push(`Attachment: ${appointment.attachment_url}`);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * Creates a calendar event for a confirmed appointment. Returns
 * { eventId, meetUrl } (meetUrl null unless generateMeetLink was
 * requested and Google actually returned one), or null if nothing is
 * connected or the call fails - a booking must never be blocked or
 * rolled back by a Google API problem.
 *
 * @param {boolean} [options.generateMeetLink] - when true, asks Google to
 *   attach a real Google Meet link to the event (conferenceData), the same
 *   mechanism Google Calendar's own UI uses to add a Meet link.
 */
async function createEvent(calendarId, appointment, options = {}) {
  try {
    const auth = await getAuthedClient();
    if (!auth) return null;
    const calendar = google.calendar({ version: 'v3', auth });
    const { data } = await calendar.events.insert({
      calendarId: calendarId || 'primary',
      conferenceDataVersion: options.generateMeetLink ? 1 : 0,
      requestBody: {
        summary: `${appointment.customer_name} (Bookly)`,
        description: buildDescription(appointment),
        start: { dateTime: appointment.start_time },
        end: { dateTime: appointment.end_time },
        conferenceData: options.generateMeetLink
          ? {
              createRequest: {
                requestId: `bookly-${appointment.id}`,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            }
          : undefined,
      },
    });
    logger.info({ appointment_id: appointment.id, google_event_id: data.id }, 'Google Calendar event created');
    return { eventId: data.id, meetUrl: data.hangoutLink || null };
  } catch (err) {
    logger.warn({ err: err.message, appointment_id: appointment.id }, 'Google Calendar event creation failed, ignoring');
    return null;
  }
}

/**
 * Re-syncs an existing event's description (notes + attachment link) after
 * a note is added to an already-booked appointment - a real UPDATE via
 * calendar.events.patch, not a second insert. Same resilience rule as
 * createEvent/deleteEvent: a Google outage or missing connection here must
 * never fail the note-saving itself, just skip the sync silently (logged).
 */
async function updateEventDescription(calendarId, eventId, appointment) {
  if (!eventId) return;
  try {
    const auth = await getAuthedClient();
    if (!auth) return;
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.patch({
      calendarId: calendarId || 'primary',
      eventId,
      requestBody: { description: buildDescription(appointment) },
    });
    logger.info({ google_event_id: eventId }, 'Google Calendar event description updated');
  } catch (err) {
    logger.warn({ err: err.message, google_event_id: eventId }, 'Google Calendar event description update failed, ignoring');
  }
}

async function deleteEvent(calendarId, eventId) {
  if (!eventId) return;
  try {
    const auth = await getAuthedClient();
    if (!auth) return;
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: calendarId || 'primary', eventId });
    logger.info({ google_event_id: eventId }, 'Google Calendar event deleted');
  } catch (err) {
    logger.warn({ err: err.message, google_event_id: eventId }, 'Google Calendar event deletion failed, ignoring');
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  handleOAuthCallback,
  getStatus,
  disconnect,
  getBusyRanges,
  createEvent,
  updateEventDescription,
  deleteEvent,
};
