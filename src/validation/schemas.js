const { z } = require('zod');

const timeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/, 'Expected HH:MM or HH:MM:SS');

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const createResourceSchema = z.object({
  name: z.string().min(1).max(200),
  timezone: z.string().min(1).max(100).default('UTC'),
  slot_duration_minutes: z.number().int().positive().default(30),
});

const createAvailabilityRuleSchema = z
  .object({
    day_of_week: z.number().int().min(0).max(6),
    start_time: timeString,
    end_time: timeString,
    break_start: timeString.nullable().optional(),
    break_end: timeString.nullable().optional(),
  })
  .refine((r) => r.end_time > r.start_time, {
    message: 'end_time must be after start_time',
    path: ['end_time'],
  })
  .refine((r) => (r.break_start == null) === (r.break_end == null), {
    message: 'break_start and break_end must both be present or both absent',
    path: ['break_end'],
  })
  .refine((r) => !r.break_start || r.break_end > r.break_start, {
    message: 'break_end must be after break_start',
    path: ['break_end'],
  });

const createExceptionSchema = z.object({
  date: dateString,
  is_closed: z.boolean().default(true),
  reason: z.string().max(500).nullable().optional(),
});

const availableSlotsQuerySchema = z.object({
  date: dateString,
  duration: z.coerce.number().int().positive().optional(),
});

const createAppointmentSchema = z
  .object({
    resource_id: z.string().uuid(),
    start_time: z.string().datetime({ offset: true }).or(z.string().min(1)),
    duration: z.number().int().positive().optional(),
    end_time: z.string().min(1).optional(),
    customer_name: z.string().min(1).max(200),
    customer_email: z.string().email(),
    customer_phone: z.string().max(50).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    // Bot-collected link only (e.g. a Drive URL pasted into chat) - not a
    // file upload. See db/schema.sql's comment for why this is a URL
    // string, never a native Calendar attachment.
    attachment_url: z.string().url().max(2000).nullable().optional(),
  })
  .refine((b) => b.duration || b.end_time, {
    message: 'Either duration (minutes) or end_time must be provided',
    path: ['duration'],
  });

const rescheduleAppointmentSchema = z
  .object({
    start_time: z.string().min(1),
    duration: z.number().int().positive().optional(),
    end_time: z.string().min(1).optional(),
    // Optional resource reassignment - moves the appointment to a
    // DIFFERENT resource, not just a different time. Bookly's own
    // endpoint stays public/unauthenticated by original design (a real
    // customer can still reschedule their own booking's TIME this same
    // way); ChatMate360 is the layer that decides only its own
    // admin-chat tool set is ever allowed to actually supply this field -
    // see toolAuthorization.service.ts's admin_reassign_appointment.
    resource_id: z.string().uuid().optional(),
  })
  .refine((b) => b.duration || b.end_time, {
    message: 'Either duration (minutes) or end_time must be provided',
    path: ['duration'],
  });

// The mid-conversation "add a note to this meeting" action - at least one
// of note/attachment_url must be provided (an empty call is a no-op worth
// rejecting explicitly rather than silently accepting).
const addNoteSchema = z
  .object({
    note: z.string().min(1).max(2000).optional(),
    attachment_url: z.string().url().max(2000).optional(),
  })
  .refine((b) => b.note || b.attachment_url, {
    message: 'Provide a note and/or an attachment_url',
  });

const appointmentsQuerySchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().min(1).optional(),
    resource_id: z.string().uuid().optional(),
    status: z.enum(['CONFIRMED', 'CANCELLED']).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(500).default(200),
  })
  .refine((q) => q.email || q.phone || q.resource_id || q.status || q.from || q.to, {
    message: 'Provide at least one filter: email, phone, resource_id, status, from, or to',
  });

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const createUserSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  role: z.enum(['ADMIN', 'STAFF']),
});

const signupSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

const updateProfileSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
  })
  .refine((b) => b.name || b.email, { message: 'Provide name and/or email to update' });

const changePasswordSchema = z
  .object({
    current_password: z.string().min(1),
    new_password: z.string().min(8).max(200),
  })
  .refine((b) => b.current_password !== b.new_password, {
    message: 'New password must be different from the current password',
    path: ['new_password'],
  });

// A resource syncs to exactly one calendar provider at a time (or none) -
// provider: 'none' clears whichever was set, so there's never an ambiguous
// "which calendar is authoritative for busy time" situation.
const updateResourceCalendarSchema = z
  .object({
    provider: z.enum(['google', 'microsoft', 'none']),
    calendar_id: z.string().min(1).max(300).nullable().optional(),
  })
  .refine((b) => b.provider === 'none' || b.calendar_id, {
    message: 'calendar_id is required unless provider is "none"',
    path: ['calendar_id'],
  });

const updateResourceVideoProviderSchema = z.object({
  provider: z.enum(['zoom', 'google_meet']).nullable(),
});

const createExternalFeedSchema = z.object({
  ics_url: z.string().url().max(2000),
  label: z.string().min(1).max(200),
});

const createContactMessageSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  message: z.string().min(1).max(5000),
});

const createApiKeySchema = z.object({
  label: z.string().min(1).max(200),
  // Omitted/null = unrestricted (admin) key. Every key issued to an
  // external integration like ChatMate360 should always set this.
  resource_id: z.string().uuid().nullable().optional(),
});

const createWaitlistEntrySchema = z.object({
  resource_id: z.string().uuid(),
  customer_name: z.string().min(1).max(200),
  customer_email: z.string().email(),
  requested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'requested_date must be YYYY-MM-DD'),
});

const updateResourceServiceInfoSchema = z.object({
  price_cents: z.number().int().nonnegative().nullable().optional(),
  price_currency: z.string().length(3).optional(),
  service_description: z.string().max(2000).nullable().optional(),
});

module.exports = {
  createResourceSchema,
  loginSchema,
  createUserSchema,
  createAvailabilityRuleSchema,
  createExceptionSchema,
  availableSlotsQuerySchema,
  createAppointmentSchema,
  rescheduleAppointmentSchema,
  addNoteSchema,
  appointmentsQuerySchema,
  updateResourceCalendarSchema,
  updateResourceVideoProviderSchema,
  createExternalFeedSchema,
  createContactMessageSchema,
  signupSchema,
  updateProfileSchema,
  changePasswordSchema,
  createApiKeySchema,
  createWaitlistEntrySchema,
  updateResourceServiceInfoSchema,
};
