const ical = require('node-ical');
const pool = require('../db/pool');
const logger = require('../logger');
const { ApiError } = require('../middleware/errors');

/**
 * Fetches and parses an ICS URL, returning its VEVENTs as
 * { start_time, end_time } UTC ISO ranges. Throws on any failure (bad URL,
 * unreachable, not actually ICS) - used both to validate a feed before
 * saving it, and by the periodic sync job.
 */
async function fetchEvents(icsUrl) {
  const parsed = await ical.async.fromURL(icsUrl);
  const events = Object.values(parsed).filter((item) => item.type === 'VEVENT' && item.start && item.end);
  if (events.length === 0 && Object.keys(parsed).length === 0) {
    throw new Error('No calendar data found at that URL');
  }
  return events.map((event) => ({
    start_time: new Date(event.start).toISOString(),
    end_time: new Date(event.end).toISOString(),
  }));
}

/**
 * Validates a candidate feed URL by actually fetching + parsing it, before
 * it's ever saved. Surfaces a clear 400 rather than saving a feed that was
 * never going to work.
 */
async function validateFeedUrl(icsUrl) {
  try {
    await fetchEvents(icsUrl);
  } catch (err) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Could not read that URL as a calendar feed: ${err.message}`);
  }
}

/**
 * Fetches one feed and refreshes its cached busy blocks. On success,
 * fully replaces the cache (delete+reinsert) so stale/cancelled events
 * disappear. On failure, leaves the existing cache alone (stale but
 * present beats nothing) and just marks the feed as errored - a feed
 * outage never blocks bookings.
 */
async function syncFeed(feed) {
  const client = await pool.connect();
  try {
    const events = await fetchEvents(feed.ics_url);

    await client.query('BEGIN');
    await client.query('DELETE FROM external_feed_busy_blocks WHERE feed_id = $1', [feed.id]);
    for (const event of events) {
      await client.query(
        'INSERT INTO external_feed_busy_blocks (feed_id, start_time, end_time) VALUES ($1, $2, $3)',
        [feed.id, event.start_time, event.end_time]
      );
    }
    await client.query(
      `UPDATE external_calendar_feeds
       SET last_fetched_at = now(), last_fetch_status = 'ok', last_fetch_error = NULL
       WHERE id = $1`,
      [feed.id]
    );
    await client.query('COMMIT');
    logger.info({ feed_id: feed.id, label: feed.label, event_count: events.length }, 'ICS feed synced');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(
      `UPDATE external_calendar_feeds
       SET last_fetched_at = now(), last_fetch_status = 'error', last_fetch_error = $2
       WHERE id = $1`,
      [feed.id, err.message]
    );
    logger.warn({ feed_id: feed.id, label: feed.label, err: err.message }, 'ICS feed sync failed, ignoring');
  } finally {
    client.release();
  }
}

async function syncAllFeeds() {
  const { rows: feeds } = await pool.query('SELECT * FROM external_calendar_feeds');
  for (const feed of feeds) {
    await syncFeed(feed);
  }
  return feeds.length;
}

/**
 * Cached busy ranges (UTC ISO) from every feed subscribed to a resource,
 * overlapping [timeMinIso, timeMaxIso]. Purely reads the cache populated
 * by the periodic sync job - never fetches live, so this is always fast
 * regardless of how slow or large the upstream feeds are.
 */
async function getFeedBusyForResource(resourceId, timeMinIso, timeMaxIso) {
  const { rows } = await pool.query(
    `SELECT b.start_time, b.end_time
     FROM external_feed_busy_blocks b
     JOIN external_calendar_feeds f ON f.id = b.feed_id
     WHERE f.resource_id = $1
       AND tstzrange(b.start_time, b.end_time) && tstzrange($2::timestamptz, $3::timestamptz)`,
    [resourceId, timeMinIso, timeMaxIso]
  );
  return rows;
}

module.exports = { fetchEvents, validateFeedUrl, syncFeed, syncAllFeeds, getFeedBusyForResource };
