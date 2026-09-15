const express = require('express');
const { asyncHandler } = require('../middleware/errors');
const { authenticate } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { loginSchema, signupSchema, updateProfileSchema, changePasswordSchema } = require('../validation/schemas');
const authService = require('../services/authService');
const pool = require('../db/pool');
const { NotFoundError } = require('../middleware/errors');

const router = express.Router();

router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await authService.login(email, password);
    res.json(result);
  })
);

router.post(
  '/signup',
  validateBody(signupSchema),
  asyncHandler(async (req, res) => {
    const user = await authService.signup(req.body);
    res.status(201).json({
      user,
      message: 'Account created. An admin needs to approve it before you can sign in.',
    });
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (rows.length === 0) throw new NotFoundError('User not found');
    res.json(authService.toPublicUser(rows[0]));
  })
);

// Self-service: any logged-in user (ADMIN or STAFF) can update their own
// name/email. Role and is_active are never touched here - those stay
// ADMIN-controlled via /users.
router.patch(
  '/me',
  authenticate,
  validateBody(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const user = await authService.updateProfile(req.user.id, req.body);
    // Re-issue the token so a changed name/email is reflected immediately,
    // without forcing the user to log in again.
    const token = authService.issueToken(user);
    res.json({ user, token });
  })
);

router.post(
  '/change-password',
  authenticate,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    await authService.changePassword(req.user.id, {
      currentPassword: req.body.current_password,
      newPassword: req.body.new_password,
    });
    res.json({ changed: true });
  })
);

module.exports = router;
