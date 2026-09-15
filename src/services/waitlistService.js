const pool = require('../db/pool');
const logger = require('../logger');
const emailService = require('./emailService');
const { ApiError } = require('../middleware/errors');

/**
 * A customer asked to be notified if a slot opens up on a date that was
 * fully booked. Same public, no-auth contract as POST /appointments -
 * an AI system or a direct customer can both call this.
 */
async function addToWaitlist({ resource_id, customer_name, customer_email, requested_date }) {
  const { rows } = await pool.query('SELECT id FROM resources WHERE id = $1', [resource_id]);
  if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', `Resource ${resource_id} not found`);

  const { rows: inserted } = await pool.query(
    `INSERT INTO appointment_waitlist (resource_id, customer_name, customer_email, requested_date)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [resource_id, customer_name, customer_email, requested_date]
  );
  logger.info({ waitlist_id: inserted[0].id, resource_id, requested_date }, 'Customer added to waitlist');
  return inserted[0];
}

/**
 * Called after every real cancellation (appointmentService.js) - checks
 * whether anyone is waiting for THIS resource on THIS exact date, and if
 * so, emails the first one still waiting (oldest request first - the
 * fairest simple rule) that a slot just opened up. Best-effort throughout:
 * a failure here never affects the cancellation that already succeeded.
 * Deliberately notifies only ONE entry per freed slot, not everyone
 * waiting - multiple people racing to grab the same single slot would
 * otherwise all be told it's available when only one of them can actually
 * get it.
 */
async function notifyWaitlistForFreedSlot(resource, cancelledAppointment) {
  try {
    const date = new Date(cancelledAppointment.start_time).toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT * FROM appointment_waitlist
       WHERE resource_id = $1 AND requested_date = $2 AND notified_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
      [resource.id, date]
    );
    if (rows.length === 0) return;

    const entry = rows[0];
    const sent = await emailService.sendWaitlistNotificationEmail(entry, resource.name, date);
    if (sent) {
      await pool.query('UPDATE appointment_waitlist SET notified_at = now() WHERE id = $1', [entry.id]);
      logger.info({ waitlist_id: entry.id, resource_id: resource.id, date }, 'Waitlist entry notified of freed slot');
    }
  } catch (err) {
    logger.warn({ resource_id: resource.id, err: err.message }, 'Waitlist notification check failed, ignoring');
  }
}

async function listWaitlistForResource(resource_id) {
  const { rows } = await pool.query(
    `SELECT * FROM appointment_waitlist WHERE resource_id = $1 AND notified_at IS NULL ORDER BY requested_date ASC, created_at ASC`,
    [resource_id]
  );
  return rows;
}

module.exports = { addToWaitlist, notifyWaitlistForFreedSlot, listWaitlistForResource };
