const express = require('express');
const { asyncHandler } = require('../middleware/errors');
const { authenticate, requireRole } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { createUserSchema } = require('../validation/schemas');
const authService = require('../services/authService');

const router = express.Router();

// Every route here is ADMIN-only: creating accounts and changing who can
// log in is exactly the kind of action that shouldn't be self-service.
router.use(authenticate, requireRole('ADMIN'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await authService.listUsers());
  })
);

router.post(
  '/',
  validateBody(createUserSchema),
  asyncHandler(async (req, res) => {
    const user = await authService.createUser(req.body);
    res.status(201).json(user);
  })
);

router.post(
  '/:id/deactivate',
  asyncHandler(async (req, res) => {
    res.json(await authService.setUserActive(req.params.id, false));
  })
);

router.post(
  '/:id/reactivate',
  asyncHandler(async (req, res) => {
    res.json(await authService.setUserActive(req.params.id, true));
  })
);

module.exports = router;
