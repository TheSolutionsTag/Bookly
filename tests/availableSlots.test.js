const { computeAvailableSlots } = require('../src/services/availabilityService');

const resource = { id: 'r1', timezone: 'America/New_York' };

// 2026-09-14 is a Monday. Rule: Mon 9:00-17:00 with a 12:00-13:00 break.
const mondayRule = {
  day_of_week: 1,
  start_time: '09:00',
  end_time: '17:00',
  break_start: '12:00',
  break_end: '13:00',
};

describe('computeAvailableSlots', () => {
  test('respects working hours and excludes the lunch break', () => {
    const slots = computeAvailableSlots({
      resource,
      date: '2026-09-14',
      durationMinutes: 60,
      rules: [mondayRule],
      exception: null,
      bookedAppointments: [],
    });

    // 09:00-12:00 -> 3 slots, 13:00-17:00 -> 4 slots = 7 total
    expect(slots).toHaveLength(7);
    expect(slots[0]).toBe('2026-09-14T13:00:00.000Z'); // 09:00 EDT
    expect(slots).not.toContain('2026-09-14T16:00:00.000Z'); // 12:00 EDT (break)
    expect(slots).toContain('2026-09-14T17:00:00.000Z'); // 13:00 EDT (after break)
  });

  test('returns nothing for a day with no matching rule', () => {
    const slots = computeAvailableSlots({
      resource,
      date: '2026-09-15', // Tuesday, no rule defined
      durationMinutes: 30,
      rules: [mondayRule],
      exception: null,
      bookedAppointments: [],
    });
    expect(slots).toEqual([]);
  });

  test('returns nothing when an exception marks the day closed', () => {
    const slots = computeAvailableSlots({
      resource,
      date: '2026-09-14',
      durationMinutes: 30,
      rules: [mondayRule],
      exception: { is_closed: true, reason: 'Holiday' },
      bookedAppointments: [],
    });
    expect(slots).toEqual([]);
  });

  test('excludes slots that overlap an existing confirmed appointment', () => {
    const slots = computeAvailableSlots({
      resource,
      date: '2026-09-14',
      durationMinutes: 30,
      rules: [mondayRule],
      exception: null,
      bookedAppointments: [
        // 09:00-09:30 EDT booked
        { start_time: '2026-09-14T13:00:00.000Z', end_time: '2026-09-14T13:30:00.000Z' },
      ],
    });

    expect(slots).not.toContain('2026-09-14T13:00:00.000Z');
    expect(slots).toContain('2026-09-14T13:30:00.000Z');
  });

  test('excludes a slot that only partially overlaps a booking', () => {
    const slots = computeAvailableSlots({
      resource,
      date: '2026-09-14',
      durationMinutes: 30,
      rules: [mondayRule],
      exception: null,
      bookedAppointments: [
        // 09:15-09:45 EDT booked - overlaps both the 09:00 and 09:30 slots
        { start_time: '2026-09-14T13:15:00.000Z', end_time: '2026-09-14T13:45:00.000Z' },
      ],
    });

    expect(slots).not.toContain('2026-09-14T13:00:00.000Z');
    expect(slots).not.toContain('2026-09-14T13:30:00.000Z');
    expect(slots).toContain('2026-09-14T14:00:00.000Z');
  });
});
