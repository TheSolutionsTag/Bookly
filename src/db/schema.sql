-- Bookly schema
-- Requires btree_gist for the exclusion constraint that makes double-booking
-- impossible at the database level (not just in application logic).

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('ADMIN', 'STAFF');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'STAFF',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  slot_duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (slot_duration_minutes > 0),
  -- Which calendar this resource syncs to/from, on the connected external
  -- account (e.g. a specific Google Calendar ID). NULL means "not synced",
  -- even if an integration is connected system-wide.
  google_calendar_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per external provider (google, and later microsoft/zoom, following
-- the same shape). This is a system-wide connection (one connected account
-- for the whole business), not per-resource and not per-user.
CREATE TABLE IF NOT EXISTS integrations (
  provider TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  account_email TEXT,
  connected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS availability_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  break_start TIME,
  break_end TIME,
  CHECK (end_time > start_time),
  CHECK (
    (break_start IS NULL AND break_end IS NULL)
    OR (break_start IS NOT NULL AND break_end IS NOT NULL AND break_end > break_start
        AND break_start >= start_time AND break_end <= end_time)
  )
);

CREATE INDEX IF NOT EXISTS idx_availability_rules_resource ON availability_rules(resource_id);

CREATE TABLE IF NOT EXISTS availability_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  is_closed BOOLEAN NOT NULL DEFAULT true,
  reason TEXT,
  UNIQUE (resource_id, date)
);

CREATE INDEX IF NOT EXISTS idx_availability_exceptions_resource_date ON availability_exceptions(resource_id, date);

DO $$ BEGIN
  CREATE TYPE appointment_status AS ENUM ('CONFIRMED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  status appointment_status NOT NULL DEFAULT 'CONFIRMED',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  -- The matching event ID on the resource's connected external calendar,
  -- if any, so we can update/delete it on cancel or reschedule.
  google_event_id TEXT,
  CHECK (end_time > start_time),
  -- The core guarantee: two CONFIRMED appointments for the same resource can
  -- never overlap in time. Enforced by Postgres itself, not application code.
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_time, end_time) WITH &&
  ) WHERE (status = 'CONFIRMED')
);

CREATE INDEX IF NOT EXISTS idx_appointments_resource_time ON appointments(resource_id, start_time);
CREATE INDEX IF NOT EXISTS idx_appointments_email ON appointments(customer_email);
CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(customer_phone);

-- Additive, idempotent upgrades for databases created before the calendar
-- integration columns existed. CREATE TABLE IF NOT EXISTS above doesn't
-- retrofit columns onto an already-existing table, so this covers it.
ALTER TABLE resources ADD COLUMN IF NOT EXISTS google_calendar_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_event_id TEXT;

-- Messages submitted through the public marketing site's contact form.
-- No email is sent (no mail service is configured) - this just persists
-- the message so an Admin can actually read it, rather than the form
-- being a dead end.
CREATE TABLE IF NOT EXISTS contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);

-- === Multi-provider calendar/video sync ===================================
-- A resource syncs its bookings to at most ONE calendar provider at a time
-- (calendar_provider says which; the matching *_calendar_id column holds
-- the id on that provider - mutually exclusive by construction, since
-- PATCH /resources/:id/calendar always clears the other provider's column).
-- Video-link generation is tracked independently via video_provider, since
-- a resource can want a video link with or without any calendar sync.
-- 'zoom' works standalone; 'google_meet' is generated as part of the
-- Google Calendar event for the booking, so it requires calendar_provider
-- to already be 'google' (enforced at the settings-save step in the
-- route, not just by convention here).
ALTER TABLE resources ADD COLUMN IF NOT EXISTS calendar_provider TEXT CHECK (calendar_provider IN ('google', 'microsoft'));
ALTER TABLE resources ADD COLUMN IF NOT EXISTS microsoft_calendar_id TEXT;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS video_provider TEXT;
ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_video_provider_check;
ALTER TABLE resources ADD CONSTRAINT resources_video_provider_check CHECK (video_provider IN ('zoom', 'google_meet'));
-- Long random token gating the resource's published ICS feed - knowing the
-- resource's plain id is not enough to read its calendar.ics.
ALTER TABLE resources ADD COLUMN IF NOT EXISTS calendar_feed_token TEXT UNIQUE;
UPDATE resources SET calendar_feed_token = encode(gen_random_bytes(24), 'hex') WHERE calendar_feed_token IS NULL;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS microsoft_event_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS zoom_meeting_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS zoom_join_url TEXT;
-- Set alongside google_event_id when the resource's video provider is
-- 'google_meet' - the Meet link Google generates for that calendar event.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_meet_url TEXT;

-- === Generic ICS feed subscription (pull busy time from any platform) =====
-- A resource can have several feeds at once (e.g. synced to a calendar
-- provider AND subscribed to an unrelated Calendly export).
CREATE TABLE IF NOT EXISTS external_calendar_feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  ics_url TEXT NOT NULL,
  label TEXT NOT NULL,
  last_fetched_at TIMESTAMPTZ,
  last_fetch_status TEXT CHECK (last_fetch_status IN ('ok', 'error')),
  last_fetch_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_external_calendar_feeds_resource ON external_calendar_feeds(resource_id);

-- Cached busy blocks parsed from a feed's ICS on the last successful fetch.
-- Fully replaced (delete+reinsert) each successful sync; left as-is (stale
-- but present) on a failed fetch, so a transient outage doesn't just erase
-- everything we knew a moment ago.
CREATE TABLE IF NOT EXISTS external_feed_busy_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID NOT NULL REFERENCES external_calendar_feeds(id) ON DELETE CASCADE,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_external_feed_busy_blocks_feed ON external_feed_busy_blocks(feed_id);

-- === Calendly webhook-driven busy time (real-time alternative to the ICS
-- pull above, for businesses on a paid Calendly plan) ======================
CREATE TABLE IF NOT EXISTS calendly_busy_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  calendly_event_uri TEXT NOT NULL UNIQUE,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendly_busy_blocks_resource ON calendly_busy_blocks(resource_id);

-- === Scoped API keys for external integrations (e.g. ChatMate360) ========
-- Bookly's own booking endpoints (POST /appointments, etc.) are deliberately
-- unauthenticated by original design - meant for a business's own AI system
-- to call directly on a trusted network. A multi-tenant platform sitting in
-- front of Bookly (e.g. ChatMate360, where several unrelated chatbots may
-- share one Bookly deployment) needs a real, enforceable guarantee that a
-- key scoped to one resource can never touch another resource's
-- appointments - not just "the caller promises to only ask for its own
-- resource". This table is that scoping mechanism. It is optional and
-- purely additive: a request with NO key still behaves exactly as before
-- (see middleware/apiKeyAuth.js) - existing direct integrations are
-- unaffected. resource_id NULL means unrestricted (an admin-generated key
-- with no scope limit); every key ChatMate360-style integrations receive is
-- created WITH a resource_id.
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 of the full raw key (hex) - never the raw key itself. Looked up
  -- by key_prefix first (see lib/apiKeys.js), then confirmed with a
  -- constant-time comparison against this column - never a plain `===`.
  key_hash TEXT NOT NULL UNIQUE,
  -- Short, non-secret, indexable identifier embedded in the raw key so a
  -- presented key can be looked up without scanning every row - the prefix
  -- alone is not enough to authenticate (that's what key_hash is for).
  key_prefix TEXT NOT NULL,
  label TEXT NOT NULL,
  resource_id UUID REFERENCES resources(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_resource ON api_keys(resource_id);

-- === Attachments and admin reassignment (ChatMate360 admin-chat) =========
-- A bot-collected link (e.g. a Google Drive URL the customer/admin pasted
-- into chat), not a real file upload - Bookly has no file storage of its
-- own. Included in the Google Calendar event description alongside notes
-- when the resource is synced (see googleCalendarService.js), never as a
-- native Calendar `attachments` entry (that requires Drive API scopes this
-- integration was never granted).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS attachment_url TEXT;
-- Set on the OLD (cancelled) row only when reschedule ALSO changed the
-- resource (an admin reassignment, not an ordinary time change) - lets the
-- previously-assigned staff member see why their appointment disappeared
-- from their own resource's list, via the existing dashboard/API, without
-- building new notification infrastructure.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
-- Set on the NEW row only in that same case - which resource this
-- appointment moved FROM, so the receiving resource's view can show
-- "reassigned from <resource>" too.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reassigned_from_resource_id UUID REFERENCES resources(id) ON DELETE SET NULL;

-- Pricing/description for the ONE service a resource offers - this
-- codebase's existing one-resource-per-service simplification (see
-- booklyNodes.ts's own comment: "no 'which product' ambiguity like
-- commerce's product catalog") means these belong directly on `resources`
-- rather than a separate services table. price_cents avoids float
-- rounding for money; null price/description means "not set," not "free."
ALTER TABLE resources ADD COLUMN IF NOT EXISTS price_cents INTEGER;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS price_currency TEXT DEFAULT 'USD';
ALTER TABLE resources ADD COLUMN IF NOT EXISTS service_description TEXT;

-- === Waitlist (standout feature) =========================================
-- A customer who wanted a date with nothing open can ask to be notified if
-- something frees up - checked automatically on every real cancellation
-- (appointmentService.js's cancelAppointment -> waitlistService.js), not a
-- manual admin action. `requested_date` is a plain DATE (not a specific
-- time) since the customer is waiting on "something opening up that day,"
-- not one exact slot. notified_at null means still waiting; set once, the
-- first time a matching cancellation is found - this never re-notifies the
-- same entry twice for the same original request.
CREATE TABLE IF NOT EXISTS appointment_waitlist (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_id     UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    customer_name   TEXT NOT NULL,
    customer_email  TEXT NOT NULL,
    requested_date  DATE NOT NULL,
    notified_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appointment_waitlist_resource_date ON appointment_waitlist(resource_id, requested_date) WHERE notified_at IS NULL;

-- === Reminders =============================================================
-- Set once a reminder email genuinely goes out for this appointment - the
-- periodic reminder check (reminderService.js) filters on this being null,
-- so a resend of the same server (or several server instances) never
-- double-sends the same reminder.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
