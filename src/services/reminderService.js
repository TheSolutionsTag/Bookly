const pool = require('../db/pool');
const logger = require('../logger');
const config = require('../config');
const emailService = require('./emailService');

/**
 * Finds every CONFIRMED appointment starting within the next
 * config.reminderLeadHours that hasn't had a reminder sent yet, and sends
 * one - real transactional email via emailService.js, best-effort (a
 * failed send just leaves reminder_sent_at null, so the NEXT periodic
 * check retries it, rather than marking it "handled" on a failure).
 */
async function sendDueReminders() {
  const { rows } = await pool.query(
    `SELECT a.*, r.name AS resource_name FROM appointments a
     JOIN resources r ON r.id = a.resource_id
     WHERE a.status = 'CONFIRMED'
       AND a.reminder_sent_at IS NULL
       AND a.start_time > now()
       AND a.start_time <= now() + ($1 || ' hours')::interval`,
    [config.reminderLeadHours]
  );

  for (const appointment of rows) {
    const sent = await emailService.sendReminderEmail(appointment, appointment.resource_name);
    if (sent) {
      await pool.query('UPDATE appointments SET reminder_sent_at = now() WHERE id = $1', [appointment.id]);
      logger.info({ appointment_id: appointment.id }, 'Reminder sent');
    }
  }

  return rows.length;
}

module.exports = { sendDueReminders };
