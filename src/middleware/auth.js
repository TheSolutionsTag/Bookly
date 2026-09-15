const jwt = require('jsonwebtoken');
const config = require('../config');
const { ApiError } = require('./errors');

// Real per-user auth: a JWT bearer token issued by POST /auth/login.
// req.user is set to { id, role, email, name } for downstream handlers
// and requireRole checks.
function authenticate(req, res, next) {
  const header = req.header('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header'));
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: payload.sub, role: payload.role, email: payload.email, name: payload.name };
    next();
  } catch (err) {
    next(new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token'));
  }
}

// Optional variant for routes that stay public by original design (the
// booking endpoints) but want to know WHO acted when a caller happens to
// present a valid session - e.g. attributing a resource reassignment to
// the admin who did it via the ChatMate360 admin-chat tool set. Never
// rejects: no header, or an invalid/expired one, just proceeds with
// req.user left unset, exactly like an ordinary anonymous/AI-system call
// to this same endpoint always has.
function authenticateIfPresent(req, res, next) {
  const header = req.header('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next();
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: payload.sub, role: payload.role, email: payload.email, name: payload.name };
  } catch {
    // Invalid/expired token on an otherwise-public route - ignored, not
    // rejected; the caller just isn't attributed to a real session.
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new ApiError(403, 'FORBIDDEN', `Requires one of roles: ${roles.join(', ')}`));
    }
    next();
  };
}

module.exports = { authenticate, authenticateIfPresent, requireRole };
