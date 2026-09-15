const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { authenticateApiKeyIfPresent } = require('../middleware/apiKeyAuth');
const { asyncHandler, ApiError } = require('../middleware/errors');
const { validateQuery } = require('../middleware/validate');
const { fetchMeetingHistory, streamMeetingHistoryPdf } = require('../services/reportService');

const router = express.Router();

const meetingHistoryQuerySchema = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  resource_id: z.string().uuid().optional(),
});

// ADMIN-only-or-scoped-API-key. Real attendee data (name/email, notes) must
// never be reachable by STAFF or an anonymous caller, same sensitivity bar
// as ADMIN-only everywhere else (resources, users, api-keys) - but a real
// Bookly login is not the only legitimate caller: a chatbot integration
// (ChatMate360) authenticates with the same resource-scoped API key it
// already uses for every other Bookly call, and never holds a Bookly user
// session. authenticateApiKeyIfPresent runs first so req.apiKey is set
// before this decides which gate applies; a valid key (checked, not
// revoked) satisfies this route the same way a real ADMIN session does,
// and forceApiKeyResourceScope below still confines a scoped key to its
// own resource. See tests/meetingHistoryReport.test.js.
function requireAdminOrApiKey(req, res, next) {
  if (req.apiKey) return next();
  return authenticate(req, res, (err) => {
    if (err) return next(err);
    requireRole('ADMIN')(req, res, next);
  });
}

// Mirrors appointments.js's forceApiKeyResourceScope exactly: a scoped key
// is pinned to its own resource_id, and an explicit request for a
// different resource_id is rejected outright (404, not 403 - same
// cross-tenant-probing discipline as every other scoped-key route) rather
// than silently narrowed. A real ADMIN session (no req.apiKey) or an
// unscoped key is unaffected, consistent with enforceApiKeyResourceScope.
function forceApiKeyResourceScope(req, res, next) {
  if (!req.apiKey || !req.apiKey.resourceId) return next();
  if (req.validatedQuery.resource_id && req.validatedQuery.resource_id !== req.apiKey.resourceId) {
    return next(new ApiError(404, 'NOT_FOUND', 'Not found'));
  }
  req.validatedQuery.resource_id = req.apiKey.resourceId;
  next();
}

router.get(
  '/meeting-history',
  authenticateApiKeyIfPresent,
  requireAdminOrApiKey,
  validateQuery(meetingHistoryQuerySchema),
  forceApiKeyResourceScope,
  asyncHandler(async (req, res) => {
    const { from, to, resource_id } = req.validatedQuery;
    const rows = await fetchMeetingHistory({ from, to, resource_id });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="meeting-history.pdf"');
    await streamMeetingHistoryPdf(res, rows, { from, to, resource_id });
  })
);

module.exports = router;
