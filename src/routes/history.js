'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 25;
    const offset = (page - 1) * pageSize;
    const trades = await db.all(
      'SELECT * FROM trade_history WHERE user_id = ? ORDER BY closed_at DESC LIMIT ? OFFSET ?',
      [req.user.id, pageSize, offset]
    );
    const totalRow = await db.get('SELECT COUNT(*) as c FROM trade_history WHERE user_id = ?', [req.user.id]);
    res.json({ trades, total: totalRow?.c || 0, page, pageSize });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
