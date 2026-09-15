// Typed application errors so route handlers can throw instead of
// hand-rolling res.status(...).json(...) everywhere, and the central
// error handler can map each type to the right HTTP status.

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class NotFoundError extends ApiError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

class ValidationError extends ApiError {
  constructor(details) {
    super(400, 'VALIDATION_ERROR', 'Request failed validation', details);
  }
}

class ConflictError extends ApiError {
  constructor(message = 'Conflict') {
    super(409, 'CONFLICT', message);
  }
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function errorHandler(logger) {
  return (err, req, res, _next) => {
    if (err instanceof ApiError) {
      if (err.status >= 500) {
        logger.error({ err, path: req.path }, err.message);
      }
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }

    logger.error({ err, path: req.path }, 'Unhandled error');
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
  };
}

module.exports = { ApiError, NotFoundError, ValidationError, ConflictError, asyncHandler, errorHandler };
