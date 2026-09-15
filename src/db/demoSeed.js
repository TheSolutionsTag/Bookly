// Optional: populates a handful of realistic resources, hours, staff
// accounts, and appointments so the dashboard has real content to look at
// right after setup. Safe to re-run - it skips anything that already
// exists by name/email.
const pool = require('./pool');
const authService = require('../services/authService');
const { createAppointment, cancelAppointment } = require('../services/appointmentService');
const logger = require('../logger');

const RESOURCES = [
  {
    name: 'Dr. Amina Iqbal',
    timezone: 'America/New_York',
    slot_duration_minutes: 30,
    hours: [1, 2, 3, 4, 5].map((d) => ({ day_of_week: d, start_time: '09:00', end_time: '17:00', break_start: '12:00', break_end: '13:00' })),
  },
  {
    name: 'Dr. James Carter',
    timezone: 'Europe/London',
    slot_duration_minutes: 20,
    hours: [1, 2, 3, 4].map((d) => ({ day_of_week: d, start_time: '08:30', end_time: '16:30', break_start: '12:30', break_end: '13:00' })),
  },
  {
    name: 'Meeting Room A',
    timezone: 'Asia/Karachi',
    slot_duration_minutes: 60,
    hours: [1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, start_time: '09:00', end_time: '18:00', break_start: null, break_end: null })),
  },
];

const STAFF = [
  { name: 'Sam Rivera', email: 'sam@example.com', password: 'staffpass123', role: 'STAFF' },
  { name: 'Jordan Lee', email: 'jordan@example.com', password: 'staffpass123', role: 'STAFF' },
];

// Finds the next date (strictly after today) that falls on the given
// Postgres-style day_of_week (0 = Sunday ... 6 = Saturday), optionally
// pushed out by extra full weeks for variety across multiple bookings.
function nextDateForWeekday(targetDow, weeksAhead = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== targetDow) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  d.setUTCDate(d.getUTCDate() + weeksAhead * 7);
  return d.toISOString().slice(0, 10);
}

async function ensureResource(def) {
  const existing = await pool.query('SELECT * FROM resources WHERE name = $1', [def.name]);
  if (existing.rows.length > 0) return existing.rows[0];

  const { rows } = await pool.query(
    'INSERT INTO resources (name, timezone, slot_duration_minutes) VALUES ($1, $2, $3) RETURNING *',
    [def.name, def.timezone, def.slot_duration_minutes]
  );
  const resource = rows[0];
  for (const rule of def.hours) {
    await pool.query(
      `INSERT INTO availability_rules (resource_id, day_of_week, start_time, end_time, break_start, break_end)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [resource.id, rule.day_of_week, rule.start_time, rule.end_time, rule.break_start, rule.break_end]
    );
  }
  logger.info({ resource_id: resource.id, name: def.name }, 'Demo resource created');
  return resource;
}

async function ensureStaff(def) {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [def.email]);
  if (existing.rows.length > 0) return;
  await authService.createUser(def);
}

async function bookIfFree(resource, isoStart, duration, customer) {
  try {
    await createAppointment({
      resource_id: resource.id,
      start_time: isoStart,
      duration,
      customer_name: customer.name,
      customer_email: customer.email,
    });
  } catch (err) {
    // Slot already taken by an earlier run - fine, move on.
    logger.info({ resource: resource.name, isoStart }, 'Demo booking skipped (already exists)');
  }
}

async function seedDemo() {
  const resources = [];
  for (const def of RESOURCES) {
    resources.push(await ensureResource(def));
  }

  for (const staff of STAFF) {
    await ensureStaff(staff);
  }

  const customers = [
    { name: 'Alice Chen', email: 'alice@example.com' },
    { name: 'Ben Osei', email: 'ben@example.com' },
    { name: 'Carla Diaz', email: 'carla@example.com' },
    { name: 'Dev Patel', email: 'dev@example.com' },
  ];

  // A spread of upcoming appointments, targeted at specific weekdays each
  // resource is actually open on (dow: 1 = Monday ... 6 = Saturday), so
  // seeding is reliable regardless of what day "today" happens to be.
  const bookings = [
    { resource: resources[0], dow: 1, weeksAhead: 0, hourUtc: 14, duration: 30, customer: customers[0] }, // Mon 10:00 EDT
    { resource: resources[0], dow: 1, weeksAhead: 0, hourUtc: 15, duration: 30, customer: customers[1] }, // Mon 11:00 EDT
    { resource: resources[0], dow: 3, weeksAhead: 0, hourUtc: 14, duration: 30, customer: customers[2] }, // Wed 10:00 EDT
    { resource: resources[0], dow: 5, weeksAhead: 1, hourUtc: 19, duration: 30, customer: customers[3] }, // Fri 15:00 EDT, next week
    { resource: resources[1], dow: 2, weeksAhead: 0, hourUtc: 9, duration: 20, customer: customers[3] }, // Tue 10:00 BST
    { resource: resources[1], dow: 4, weeksAhead: 0, hourUtc: 10, duration: 20, customer: customers[0] }, // Thu 11:00 BST
    { resource: resources[2], dow: 1, weeksAhead: 0, hourUtc: 6, duration: 60, customer: customers[1] }, // Mon 11:00 PKT
    { resource: resources[2], dow: 6, weeksAhead: 0, hourUtc: 7, duration: 60, customer: customers[2] }, // Sat 12:00 PKT
    { resource: resources[2], dow: 3, weeksAhead: 1, hourUtc: 8, duration: 60, customer: customers[3] }, // Wed 13:00 PKT, next week
  ];

  for (const b of bookings) {
    const date = nextDateForWeekday(b.dow, b.weeksAhead);
    const isoStart = `${date}T${String(b.hourUtc).padStart(2, '0')}:00:00.000Z`;
    await bookIfFree(b.resource, isoStart, b.duration, b.customer);
  }

  // Cancel one booking outright so the dashboard's Cancelled filter has
  // something to show too.
  const cancelTarget = await pool.query(
    `SELECT id FROM appointments WHERE resource_id = $1 AND status = 'CONFIRMED' ORDER BY start_time ASC LIMIT 1`,
    [resources[1].id]
  );
  if (cancelTarget.rows.length > 0) {
    await cancelAppointment(cancelTarget.rows[0].id);
  }

  logger.info('Demo data seed complete');
  await pool.end();
}

seedDemo().catch((err) => {
  logger.error({ err }, 'Demo seed failed');
  process.exit(1);
});
