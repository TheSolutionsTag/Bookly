const pool = require('../db/pool');
const logger = require('../logger');
const config = require('../config');

const PROVIDER = 'microsoft';
const SCOPES = 'offline_access User.Read Calendars.ReadWrite';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function authorizeUrl() {
  return `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/authorize`;
}

function tokenUrl() {
  return `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/token`;
}

function isConfigured() {
  return Boolean(config.microsoft.clientId && config.microsoft.clientSecret && config.microsoft.redirectUri);
}

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.microsoft.clientId,
    response_type: 'code',
    redirect_uri: config.microsoft.redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
  });
  return `${authorizeUrl()}?${params.toString()}`;
}

async function exchangeToken(body) {
  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.microsoft.clientId,
      client_secret: config.microsoft.clientSecret,
      redirect_uri: config.microsoft.redirectUri,
      scope: SCOPES,
      ...body,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Microsoft token request failed: ${data.error_description || data.error || res.status}`);
  }
  return data;
}

async function saveTokens(tokens, accountEmail, connectedByUserId) {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  await pool.query(
    `INSERT INTO integrations (provider, access_token, refresh_token, expires_at, account_email, connected_by, connected_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (provider) DO UPDATE SET
       access_token = $2,
       refresh_token = COALESCE($3, integrations.refresh_token),
       expires_at = $4,
       account_email = COALESCE($5, integrations.account_email),
       connected_by = COALESCE($6, integrations.connected_by),
       connected_at = now()`,
    [PROVIDER, tokens.access_token, tokens.refresh_token || null, expiresAt, accountEmail || null, connectedByUserId || null]
  );
}

async function handleOAuthCallback(code, connectedByUserId) {
  const tokens = await exchangeToken({ code, grant_type: 'authorization_code' });

  const profileRes = await fetch(`${GRAPH_BASE}/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await profileRes.json();
  const accountEmail = profile.mail || profile.userPrincipalName || null;

  await saveTokens(tokens, accountEmail, connectedByUserId);
  logger.info({ email: accountEmail }, 'Microsoft Calendar connected');
  return accountEmail;
}

async function getStatus() {
  const { rows } = await pool.query(
    'SELECT provider, account_email, connected_at FROM integrations WHERE provider = $1',
    [PROVIDER]
  );
  return rows[0] || null;
}

async function disconnect() {
  await pool.query('DELETE FROM integrations WHERE provider = $1', [PROVIDER]);
  logger.info('Microsoft Calendar disconnected');
}

/**
 * Returns a valid access token for Graph API calls, refreshing it first if
 * it's expired (or close to it) and persisting the new one - or null if
 * nothing is connected. Mirrors googleCalendarService's transparent
 * refresh-on-use behavior, hand-rolled since there's no SDK here.
 */
async function getValidAccessToken() {
  const { rows } = await pool.query('SELECT * FROM integrations WHERE provider = $1', [PROVIDER]);
  const record = rows[0];
  if (!record) return null;

  const expiresAt = record.expires_at ? new Date(record.expires_at).getTime() : 0;
  const stillValid = expiresAt - Date.now() > 60_000; // 1 minute of slack
  if (stillValid) return record.access_token;

  if (!record.refresh_token) return record.access_token; // best effort - let the API call itself fail if truly expired

  const tokens = await exchangeToken({ refresh_token: record.refresh_token, grant_type: 'refresh_token' });
  await saveTokens(tokens, record.account_email, record.connected_by);
  return tokens.access_token;
}

function eventsUrl(calendarId) {
  return calendarId && calendarId !== 'primary'
    ? `${GRAPH_BASE}/me/calendars/${encodeURIComponent(calendarId)}/events`
    : `${GRAPH_BASE}/me/events`;
}

function calendarViewUrl(calendarId, startIso, endIso) {
  const base =
    calendarId && calendarId !== 'primary'
      ? `${GRAPH_BASE}/me/calendars/${encodeURIComponent(calendarId)}/calendarView`
      : `${GRAPH_BASE}/me/calendarView`;
  const params = new URLSearchParams({ startDateTime: startIso, endDateTime: endIso });
  return `${base}?${params.toString()}`;
}

/**
 * Busy time ranges (UTC ISO instants) from the given calendar over
 * [timeMin, timeMax]. Returns [] if nothing is connected, or on any API
 * error - never blocks availability on a Microsoft outage.
 */
async function getBusyRanges(calendarId, timeMinIso, timeMaxIso) {
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return [];

    const res = await fetch(calendarViewUrl(calendarId, timeMinIso, timeMaxIso), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    if (!res.ok) throw new Error(`Graph calendarView returned ${res.status}`);
    const data = await res.json();
    return (data.value || []).map((event) => ({
      start_time: `${event.start.dateTime}Z`,
      end_time: `${event.end.dateTime}Z`,
    }));
  } catch (err) {
    logger.warn({ err: err.message, calendarId }, 'Microsoft calendarView lookup failed, ignoring');
    return [];
  }
}

/**
 * Creates a calendar event for a confirmed appointment. Returns the new
 * event's ID, or null if nothing is connected or the call fails - a
 * booking must never be blocked or rolled back by a Microsoft API problem.
 */
async function createEvent(calendarId, appointment) {
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return null;

    const res = await fetch(eventsUrl(calendarId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subject: `${appointment.customer_name} (Bookly)`,
        body: { contentType: 'text', content: appointment.notes || '' },
        start: { dateTime: appointment.start_time, timeZone: 'UTC' },
        end: { dateTime: appointment.end_time, timeZone: 'UTC' },
      }),
    });
    if (!res.ok) throw new Error(`Graph event creation returned ${res.status}`);
    const data = await res.json();
    logger.info({ appointment_id: appointment.id, microsoft_event_id: data.id }, 'Microsoft Calendar event created');
    return data.id;
  } catch (err) {
    logger.warn(
      { err: err.message, appointment_id: appointment.id },
      'Microsoft Calendar event creation failed, ignoring'
    );
    return null;
  }
}

async function deleteEvent(calendarId, eventId) {
  if (!eventId) return;
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return;
    const res = await fetch(`${GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`Graph event deletion returned ${res.status}`);
    logger.info({ microsoft_event_id: eventId }, 'Microsoft Calendar event deleted');
  } catch (err) {
    logger.warn({ err: err.message, microsoft_event_id: eventId }, 'Microsoft Calendar event deletion failed, ignoring');
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
  deleteEvent,
};
