const express = require('express');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler, NotFoundError } = require('../middleware/errors');
const { validateBody } = require('../middleware/validate');
const { createApiKeySchema } = require('../validation/schemas');
const { createApiKey, revokeApiKey, listApiKeys } = require('../lib/apiKeys');

const router = express.Router();

// Admin-only key management (mirrors the Users screen's authenticate +
// requireRole('ADMIN') discipline) - a Staff account can use a resource day
// to day but must not be able to mint or revoke integration credentials.
router.use(authenticate, requireRole('ADMIN'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await listApiKeys());
  })
);

router.post(
  '/',
  validateBody(createApiKeySchema),
  asyncHandler(async (req, res) => {
    const { label, resource_id } = req.body;
    if (resource_id) {
      const { rows } = await pool.query('SELECT id FROM resources WHERE id = $1', [resource_id]);
      if (rows.length === 0) throw new NotFoundError(`Resource ${resource_id} not found`);
    }
    // The raw key is returned ONLY in this one response - it is never
    // retrievable again and is never stored anywhere but hashed.
    const key = await createApiKey({ label, resourceId: resource_id || null, createdBy: req.user.id });
    res.status(201).json(key);
  })
);

router.post(
  '/:id/revoke',
  asyncHandler(async (req, res) => {
    const revoked = await revokeApiKey(req.params.id);
    if (!revoked) throw new NotFoundError(`API key ${req.params.id} not found or already revoked`);
    res.json({ revoked: true });
  })
);

module.exports = router;
