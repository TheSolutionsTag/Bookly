const { verifyApiKey } = require('../lib/apiKeys');
const { asyncHandler, ApiError } = require('./errors');

// Optional, additive layer in front of the (deliberately public) booking
// endpoints. No key presented -> falls through unchanged (req.apiKey stays
// undefined) - existing direct-AI-system callers with no key are completely
// unaffected. A key IS presented -> it must be valid and not revoked, or
// the request is rejected outright (never silently treated as "no key").
const authenticateApiKeyIfPresent = asyncHandler(async (req, res, next) => {
  const header = req.header('authorization') || req.header('x-api-key') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
  // This same Authorization header also carries staff/admin JWTs on these
  // routes (GET /appointments's broad-query path uses `authenticate`
  // downstream) - only a token shaped like a Bookly API key (the `bk_`
  // prefix) is ours to validate here. Anything else - no header, a JWT,
  // garbage - passes through untouched so the existing JWT auth (or the
  // deliberately-public no-auth path) still runs exactly as before.
  if (!token.startsWith('bk_')) return next();

  const key = await verifyApiKey(token);
  if (!key) throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or revoked API key');
  req.apiKey = key;
  next();
});

// Enforces that a scoped key (resource_id set) can only act on the ONE
// resource it was issued for - the real cross-tenant guarantee. An
// unscoped key (resource_id null, e.g. an admin-generated backdoor key) or
// no key at all imposes no restriction here; the same discipline as every
// other ownership check in this codebase (see helebooker's
// requireOwnedChatbotId doc comment pattern) - ChatMate360-issued keys are
// always resource-scoped, so this is the check that actually matters for
// them. `getResourceId` is async so callers needing to load the target
// appointment's resource_id from the DB first (cancel/reschedule/status by
// :id) can do so.
function enforceApiKeyResourceScope(getResourceId) {
  return asyncHandler(async (req, res, next) => {
    if (!req.apiKey || !req.apiKey.resourceId) return next();
    const requestedResourceId = await getResourceId(req);
    if (requestedResourceId && requestedResourceId !== req.apiKey.resourceId) {
      // 404, not 403 - a scoped key probing for another tenant's resource
      // must not be able to distinguish "exists but not yours" from
      // "doesn't exist", same discipline as every other cross-tenant check.
      throw new ApiError(404, 'NOT_FOUND', 'Not found');
    }
    next();
  });
}

module.exports = { authenticateApiKeyIfPresent, enforceApiKeyResourceScope };
