const express = require('express');
const pool = require('../db/pool');
const logger = require('../logger');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler, NotFoundError } = require('../middleware/errors');
const { validateBody } = require('../middleware/validate');
const { createContactMessageSchema } = require('../validation/schemas');

const router = express.Router();

// Public: the marketing site's contact form. No email is sent (no mail
// service is configured) - this persists the message so an Admin can read
// it from the dashboard, rather than the form being a dead end.
router.post(
  '/',
  validateBody(createContactMessageSchema),
  asyncHandler(async (req, res) => {
    const { name, email, message } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO contact_messages (name, email, message) VALUES ($1, $2, $3) RETURNING *',
      [name, email, message]
    );
    logger.info({ contact_message_id: rows[0].id }, 'Contact message received');
    res.status(201).json(rows[0]);
  })
);

router.get(
  '/',
  authenticate,
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM contact_messages ORDER BY created_at DESC');
    res.json(rows);
  })
);

router.post(
  '/:id/read',
  authenticate,
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'UPDATE contact_messages SET read_at = now() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (rows.length === 0) throw new NotFoundError(`Contact message ${req.params.id} not found`);
    res.json(rows[0]);
  })
);

module.exports = router;
