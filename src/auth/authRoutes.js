'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const logger = require('../utils/logger');
const { requireAuth } = require('./middleware');

const router = express.Router();

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function generateReferralCode(name) {
  const base = (name || 'user').replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toUpperCase();
  return `${base}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function cookieOpts() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

// ---- Register ---------------------------------------------------------------
router.post(
  '/register',
  body('name').trim().isLength({ min: 2 }).withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { name, email, password, referralCode } = req.body;
    try {
      const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
      if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

      let referredBy = null;
      if (referralCode) {
        const referrer = await db.get('SELECT id FROM users WHERE referral_code = ?', [referralCode]);
        if (referrer) referredBy = referralCode;
      }

      const hash = await bcrypt.hash(password, 12);
      const myCode = generateReferralCode(name);

      const info = await db.run(
        'INSERT INTO users (name, email, password_hash, referral_code, referred_by) VALUES (?, ?, ?, ?, ?)',
        [name, email, hash, myCode, referredBy]
      );

      if (referredBy) {
        const referrer = await db.get('SELECT id FROM users WHERE referral_code = ?', [referredBy]);
        if (referrer) {
          await db.run('INSERT INTO referrals (referrer_id, referred_id) VALUES (?, ?)', [
            referrer.id,
            info.lastInsertRowid,
          ]);
        }
      }

      const token = signToken({ type: 'user', id: info.lastInsertRowid, email, name });
      res.cookie('token', token, cookieOpts());
      logger.info('auth', `New user registered: ${email}`);
      res.json({ token, user: { id: info.lastInsertRowid, name, email, referralCode: myCode } });
    } catch (e) {
      logger.error('auth', e.message);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
);

// ---- Login ------------------------------------------------------------------
router.post(
  '/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Email and password are required' });

    const { email, password } = req.body;
    try {
      const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      if (user.status !== 'active') return res.status(403).json({ error: 'Account is suspended' });

      const token = signToken({ type: 'user', id: user.id, email: user.email, name: user.name });
      res.cookie('token', token, cookieOpts());
      res.json({ token, user: { id: user.id, name: user.name, email: user.email, referralCode: user.referral_code } });
    } catch (e) {
      logger.error('auth', e.message);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

// ---- Logout -----------------------------------------------------------------
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// ---- Me ---------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, name, email, referral_code, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Forgot password --------------------------------------------------------
router.post('/forgot-password', body('email').isEmail().normalizeEmail(), async (req, res) => {
  const { email } = req.body;
  try {
    const user = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (!user) return res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 60 * 60 * 1000;
    await db.run('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?', [
      resetToken, expires, user.id,
    ]);

    const resetLink = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password.html?token=${resetToken}`;
    logger.info('auth', `Password reset link: ${resetLink}`);

    res.json({
      ok: true,
      message: 'If that email exists, a reset link has been sent.',
      devResetLink: process.env.SMTP_HOST ? undefined : resetLink,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Reset password ---------------------------------------------------------
router.post(
  '/reset-password',
  body('token').notEmpty(),
  body('password').isLength({ min: 8 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid request' });

    const { token, password } = req.body;
    try {
      const user = await db.get('SELECT * FROM users WHERE reset_token = ?', [token]);
      if (!user || !user.reset_token_expires || user.reset_token_expires < Date.now()) {
        return res.status(400).json({ error: 'Reset link is invalid or has expired' });
      }

      const hash = await bcrypt.hash(password, 12);
      await db.run(
        'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
        [hash, user.id]
      );
      res.json({ ok: true, message: 'Password updated. You can now log in.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ---- Admin login ------------------------------------------------------------
router.post(
  '/admin/login',
  body('username').notEmpty(),
  body('password').notEmpty(),
  async (req, res) => {
    const { username, password } = req.body;
    try {
      const admin = await db.get('SELECT * FROM admins WHERE username = ?', [username]);
      if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
        return res.status(401).json({ error: 'Invalid admin credentials' });
      }
      const token = signToken({ type: 'admin', id: admin.id, username: admin.username });
      res.cookie('admin_token', token, cookieOpts());
      res.json({ token, admin: { id: admin.id, username: admin.username } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
