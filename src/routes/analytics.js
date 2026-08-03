'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const trades = await db.all(
      'SELECT * FROM trade_history WHERE user_id = ? ORDER BY closed_at ASC',
      [req.user.id]
    );

    const bySymbol = {};
    let cumulative = 0;
    const equityCurve = [];

    for (const t of trades) {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, pnl: 0, wins: 0 };
      bySymbol[t.symbol].trades += 1;
      bySymbol[t.symbol].pnl += t.pnl;
      if (t.result === 'win') bySymbol[t.symbol].wins += 1;
      cumulative += t.pnl;
      equityCurve.push({ time: t.closed_at, equity: cumulative });
    }

    const bySource = { manual: { trades: 0, pnl: 0 }, auto: { trades: 0, pnl: 0 } };
    for (const t of trades) {
      if (!bySource[t.source]) bySource[t.source] = { trades: 0, pnl: 0 };
      bySource[t.source].trades += 1;
      bySource[t.source].pnl += t.pnl;
    }

    res.json({ bySymbol, bySource, equityCurve, totalTrades: trades.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
