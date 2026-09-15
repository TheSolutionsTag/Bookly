const { DateTime } = require('luxon');

// Hand-rolled slot generation + overlap detection (no external scheduling
// library). All wall-clock math happens in the resource's own timezone so
// that daylight-saving transitions land on the correct local hour; the
// resulting slots are handed back as absolute UTC instants.

function pgDayOfWeek(dateTime) {
  // Postgres EXTRACT(DOW): 0 = Sunday ... 6 = Saturday.
  // Luxon .weekday: 1 = Monday ... 7 = Sunday.
  return dateTime.weekday % 7;
}

function timeStringToParts(timeStr) {
  const [h, m, s] = timeStr.split(':').map(Number);
  return { hour: h, minute: m, second: s || 0 };
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

/**
 * Build the working windows (as UTC instant ranges) for a resource on a
 * given local calendar date, given its weekly rules for that day.
 * A rule with a break produces two windows instead of one.
 */
function buildWorkingWindows(rules, dateInZone, zone) {
  const windows = [];
  for (const rule of rules) {
    const start = timeStringToParts(rule.start_time);
    const end = timeStringToParts(rule.end_time);
    const dayStart = dateInZone.set({ ...start, millisecond: 0 });
    const dayEnd = dateInZone.set({ ...end, millisecond: 0 });

    if (rule.break_start && rule.break_end) {
      const breakStart = dateInZone.set({ ...timeStringToParts(rule.break_start), millisecond: 0 });
      const breakEnd = dateInZone.set({ ...timeStringToParts(rule.break_end), millisecond: 0 });
      if (breakStart > dayStart) windows.push({ start: dayStart, end: breakStart });
      if (dayEnd > breakEnd) windows.push({ start: breakEnd, end: dayEnd });
    } else {
      windows.push({ start: dayStart, end: dayEnd });
    }
  }
  return windows;
}

/**
 * @param {object} params
 * @param {{timezone: string}} params.resource
 * @param {string} params.date - 'YYYY-MM-DD'
 * @param {number} params.durationMinutes
 * @param {Array} params.rules - availability_rules rows for this resource (any day)
 * @param {{is_closed: boolean}|null} params.exception - exception row for this date, if any
 * @param {Array<{start_time: Date|string, end_time: Date|string}>} params.bookedAppointments
 * @returns {string[]} ISO-8601 UTC start times of available slots, ascending
 */
function computeAvailableSlots({ resource, date, durationMinutes, rules, exception, bookedAppointments }) {
  if (exception && exception.is_closed) {
    return [];
  }

  const zone = resource.timezone || 'UTC';
  const dateInZone = DateTime.fromISO(date, { zone });
  if (!dateInZone.isValid) {
    throw new Error(`Invalid date: ${date}`);
  }

  const dow = pgDayOfWeek(dateInZone);
  const rulesForDay = rules.filter((r) => r.day_of_week === dow);
  if (rulesForDay.length === 0) {
    return [];
  }

  const windows = buildWorkingWindows(rulesForDay, dateInZone, zone);

  const bookedRanges = bookedAppointments.map((a) => ({
    start: DateTime.fromJSDate(new Date(a.start_time)),
    end: DateTime.fromJSDate(new Date(a.end_time)),
  }));

  const slots = [];
  const durationObj = { minutes: durationMinutes };

  for (const window of windows) {
    let cursor = window.start;
    while (true) {
      const slotEnd = cursor.plus(durationObj);
      if (slotEnd > window.end) break;

      const overlapsBooking = bookedRanges.some((b) => rangesOverlap(cursor, slotEnd, b.start, b.end));
      if (!overlapsBooking) {
        slots.push(cursor.toUTC().toISO());
      }
      cursor = cursor.plus(durationObj);
    }
  }

  return slots;
}

module.exports = { computeAvailableSlots, pgDayOfWeek };
