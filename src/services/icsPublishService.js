const { createEvents } = require('ics');
const { DateTime } = require('luxon');

function toIcsDateArray(value) {
  // pg returns TIMESTAMPTZ columns as JS Date objects, not ISO strings -
  // new Date(value) normalizes either into a Date before converting.
  const dt = DateTime.fromJSDate(new Date(value), { zone: 'utc' });
  return [dt.year, dt.month, dt.day, dt.hour, dt.minute];
}

/**
 * Builds a valid ICS document listing a resource's CONFIRMED upcoming
 * appointments as VEVENTs. Deliberately generic in content (no customer
 * name/email/notes) - useful enough to block time on another calendar
 * without leaking private booking details into a URL-protected feed.
 */
function generateResourceIcs(resource, appointments) {
  const events = appointments.map((appt) => ({
    uid: `bookly-${appt.id}@bookly`,
    start: toIcsDateArray(appt.start_time),
    end: toIcsDateArray(appt.end_time),
    startInputType: 'utc',
    endInputType: 'utc',
    title: 'Booked appointment',
    description: `Booked via Bookly for ${resource.name}.`,
    status: 'CONFIRMED',
    productId: 'bookly/ics',
  }));

  const { error, value } = createEvents(events);
  if (error) throw error;
  return value;
}

module.exports = { generateResourceIcs };
