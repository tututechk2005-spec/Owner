'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, name, email, referral_code, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/', async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Name is required' });
  try {
    await db.run(
      "UPDATE users SET name = ?, updated_at = strftime('%s','now') WHERE id = ?",
      [name.trim(), req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
