require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

module.exports = {
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl: required('DATABASE_URL', 'postgres://postgres:postgres@localhost:5455/helebooker'),
  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  // Used only by the one-time bootstrap seed script to create the first
  // ADMIN account. After that, admins create further accounts (staff or
  // additional admins) through the Users screen - not through env vars.
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com',
  bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me',
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || null,
  },
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID || null,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET || null,
    redirectUri: process.env.MICROSOFT_REDIRECT_URI || null,
    // 'common' allows both personal Microsoft accounts and work/school
    // accounts to connect - the normal choice unless you specifically need
    // to restrict to one Azure AD tenant.
    tenant: process.env.MICROSOFT_TENANT || 'common',
  },
  zoom: {
    clientId: process.env.ZOOM_CLIENT_ID || null,
    clientSecret: process.env.ZOOM_CLIENT_SECRET || null,
    redirectUri: process.env.ZOOM_REDIRECT_URI || null,
  },
  calendly: {
    // Calendly v2 webhook signing key, from the webhook subscription's
    // creation response - used to verify Calendly-Webhook-Signature.
    webhookSigningKey: process.env.CALENDLY_WEBHOOK_SIGNING_KEY || null,
  },
  icsFeedSyncIntervalMinutes: parseInt(process.env.ICS_FEED_SYNC_INTERVAL_MINUTES || '20', 10),
  email: {
    // Resend's HTTP API - a single fetch call, no SDK dependency, same
    // discipline as every other optional integration here: null means
    // "not configured," and emailService.js treats that as best-effort
    // no-op (logs a warning, never blocks the real action it's attached
    // to), exactly like googleCalendarService.js's own missing-token path.
    resendApiKey: process.env.RESEND_API_KEY || null,
    fromAddress: process.env.EMAIL_FROM_ADDRESS || 'Bookly <onboarding@resend.dev>',
  },
  reminderLeadHours: parseInt(process.env.REMINDER_LEAD_HOURS || '24', 10),
  reminderCheckIntervalMinutes: parseInt(process.env.REMINDER_CHECK_INTERVAL_MINUTES || '15', 10),
};
