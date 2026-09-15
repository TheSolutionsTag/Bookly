const logger = require('../logger');
const config = require('../config');

// Real transactional email — a single fetch call to Resend's HTTP API, no
// SDK dependency, matching every other optional integration here
// (googleCalendarService.js, zoomService.js): unconfigured (no
// RESEND_API_KEY) is a normal, expected state, not an error - logged once
// per call as a warning and treated as best-effort, same as a Google
// Calendar sync failure never blocking the real booking it's attached to.
// This is what makes "I've sent a confirmation to you" (booklyNodes.ts's
// chatbot-facing text) an honest claim about what the system actually
// attempts, not a fabricated one - the previous state of this codebase had
// NO email-sending code anywhere, so that same sentence was simply false
// regardless of wording.
function isConfigured() {
  return Boolean(config.email.resendApiKey);
}

/**
 * @param {{to: string, subject: string, html: string}} input
 * @returns {Promise<boolean>} true if the send genuinely succeeded (a 2xx
 *   from Resend), false for every other outcome (not configured, Resend
 *   rejected it, network failure) - callers treat false as "logged,
 *   ignored," never as a reason to fail the real action.
 */
async function sendEmail({ to, subject, html }) {
  if (!isConfigured()) {
    logger.warn({ to, subject }, 'Email not sent: RESEND_API_KEY is not configured');
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: config.email.fromAddress, to, subject, html }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ to, subject, status: res.status, body }, 'Resend rejected the email');
      return false;
    }
    logger.info({ to, subject }, 'Email sent');
    return true;
  } catch (err) {
    logger.warn({ to, subject, err: err.message }, 'Email send failed or timed out, ignoring');
    return false;
  }
}

function formatAppointmentWhen(appointment) {
  return new Date(appointment.start_time).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

async function sendBookingConfirmationEmail(appointment, resourceName) {
  const when = formatAppointmentWhen(appointment);
  const joinLine = appointment.google_meet_url
    ? `<p>Join the meeting: <a href="${appointment.google_meet_url}">${appointment.google_meet_url}</a></p>`
    : appointment.zoom_join_url
      ? `<p>Join the meeting: <a href="${appointment.zoom_join_url}">${appointment.zoom_join_url}</a></p>`
      : '';
  return sendEmail({
    to: appointment.customer_email,
    subject: `Appointment confirmed — ${when} UTC`,
    html: `<p>Hi ${appointment.customer_name},</p><p>Your appointment with ${resourceName} is confirmed for <strong>${when} UTC</strong>.</p>${joinLine}<p>See you then!</p>`,
  });
}

async function sendCancellationEmail(appointment, resourceName) {
  const when = formatAppointmentWhen(appointment);
  return sendEmail({
    to: appointment.customer_email,
    subject: `Appointment cancelled — ${when} UTC`,
    html: `<p>Hi ${appointment.customer_name},</p><p>Your appointment with ${resourceName} on <strong>${when} UTC</strong> has been cancelled.</p>`,
  });
}

async function sendRescheduleEmail(appointment, resourceName) {
  const when = formatAppointmentWhen(appointment);
  return sendEmail({
    to: appointment.customer_email,
    subject: `Appointment rescheduled — ${when} UTC`,
    html: `<p>Hi ${appointment.customer_name},</p><p>Your appointment with ${resourceName} has been moved to <strong>${when} UTC</strong>.</p>`,
  });
}

async function sendReminderEmail(appointment, resourceName) {
  const when = formatAppointmentWhen(appointment);
  const joinLine = appointment.google_meet_url
    ? `<p>Join the meeting: <a href="${appointment.google_meet_url}">${appointment.google_meet_url}</a></p>`
    : appointment.zoom_join_url
      ? `<p>Join the meeting: <a href="${appointment.zoom_join_url}">${appointment.zoom_join_url}</a></p>`
      : '';
  return sendEmail({
    to: appointment.customer_email,
    subject: `Reminder: your appointment is coming up — ${when} UTC`,
    html: `<p>Hi ${appointment.customer_name},</p><p>This is a reminder that your appointment with ${resourceName} is coming up on <strong>${when} UTC</strong>.</p>${joinLine}`,
  });
}

async function sendWaitlistNotificationEmail(waitlistEntry, resourceName, availableDate) {
  return sendEmail({
    to: waitlistEntry.customer_email,
    subject: `A slot opened up with ${resourceName}`,
    html: `<p>Hi,</p><p>You asked to be notified if a slot opened up with ${resourceName} on <strong>${availableDate}</strong> — one just did! Reply to this chat or book again soon, as it may not stay open for long.</p>`,
  });
}

module.exports = {
  isConfigured,
  sendEmail,
  sendBookingConfirmationEmail,
  sendCancellationEmail,
  sendRescheduleEmail,
  sendReminderEmail,
  sendWaitlistNotificationEmail,
};
