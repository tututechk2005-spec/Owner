'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const signals = await db.all('SELECT * FROM ai_signals ORDER BY created_at DESC LIMIT 100');
    res.json({ signals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
