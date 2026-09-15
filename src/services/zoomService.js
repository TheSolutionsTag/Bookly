const pool = require('../db/pool');
const logger = require('../logger');
const config = require('../config');

const PROVIDER = 'zoom';
const API_BASE = 'https://api.zoom.us/v2';

function basicAuthHeader() {
  const credentials = Buffer.from(`${config.zoom.clientId}:${config.zoom.clientSecret}`).toString('base64');
  return `Basic ${credentials}`;
}

function isConfigured() {
  return Boolean(config.zoom.clientId && config.zoom.clientSecret && config.zoom.redirectUri);
}

function getAuthUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.zoom.clientId,
    redirect_uri: config.zoom.redirectUri,
    state,
  });
  return `https://zoom.us/oauth/authorize?${params.toString()}`;
}

async function exchangeToken(params) {
  const url = `https://zoom.us/oauth/token?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader() },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Zoom token request failed: ${data.reason || data.error || res.status}`);
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
  const tokens = await exchangeToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.zoom.redirectUri,
  });

  const profileRes = await fetch(`${API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await profileRes.json();

  await saveTokens(tokens, profile.email || null, connectedByUserId);
  logger.info({ email: profile.email }, 'Zoom connected');
  return profile.email;
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
  logger.info('Zoom disconnected');
}

async function getValidAccessToken() {
  const { rows } = await pool.query('SELECT * FROM integrations WHERE provider = $1', [PROVIDER]);
  const record = rows[0];
  if (!record) return null;

  const expiresAt = record.expires_at ? new Date(record.expires_at).getTime() : 0;
  const stillValid = expiresAt - Date.now() > 60_000;
  if (stillValid) return record.access_token;

  if (!record.refresh_token) return record.access_token;

  const tokens = await exchangeToken({ grant_type: 'refresh_token', refresh_token: record.refresh_token });
  await saveTokens(tokens, record.account_email, record.connected_by);
  return tokens.access_token;
}

/**
 * Creates a Zoom meeting for a confirmed appointment. Returns
 * { meetingId, joinUrl }, or null if nothing is connected or the call
 * fails - a booking must never be blocked or rolled back by a Zoom API
 * problem, it just won't have a join link.
 */
async function createMeeting(appointment) {
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return null;

    const startIso = new Date(appointment.start_time).toISOString();
    const durationMinutes = Math.max(
      1,
      Math.round((new Date(appointment.end_time) - new Date(appointment.start_time)) / 60000)
    );

    const res = await fetch(`${API_BASE}/users/me/meetings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topic: `Appointment with ${appointment.customer_name}`,
        type: 2, // scheduled meeting
        start_time: startIso,
        duration: durationMinutes,
        timezone: 'UTC',
        settings: { join_before_host: true, waiting_room: false },
      }),
    });
    if (!res.ok) throw new Error(`Zoom meeting creation returned ${res.status}`);
    const data = await res.json();
    logger.info({ appointment_id: appointment.id, zoom_meeting_id: data.id }, 'Zoom meeting created');
    return { meetingId: String(data.id), joinUrl: data.join_url };
  } catch (err) {
    logger.warn({ err: err.message, appointment_id: appointment.id }, 'Zoom meeting creation failed, ignoring');
    return null;
  }
}

async function deleteMeeting(meetingId) {
  if (!meetingId) return;
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return;
    const res = await fetch(`${API_BASE}/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`Zoom meeting deletion returned ${res.status}`);
    logger.info({ zoom_meeting_id: meetingId }, 'Zoom meeting deleted');
  } catch (err) {
    logger.warn({ err: err.message, zoom_meeting_id: meetingId }, 'Zoom meeting deletion failed, ignoring');
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  handleOAuthCallback,
  getStatus,
  disconnect,
  createMeeting,
  deleteMeeting,
};
