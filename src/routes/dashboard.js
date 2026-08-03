'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/summary', async (req, res) => {
  try {
    const userId = req.user.id;

    const accounts = await db.all(
      'SELECT id, account_type, label, is_verified FROM binance_accounts WHERE user_id = ?',
      [userId]
    );
    const openPositions = await db.all(
      "SELECT * FROM positions WHERE user_id = ? AND status = 'open'",
      [userId]
    );
    const openOrders = await db.all(
      "SELECT * FROM orders WHERE user_id = ? AND status = 'open'",
      [userId]
    );
    const trades = await db.all(
      'SELECT * FROM trade_history WHERE user_id = ? ORDER BY closed_at DESC LIMIT 200',
      [userId]
    );

    const totalTrades = trades.length;
    const wins = trades.filter((t) => t.result === 'win').length;
    const losses = trades.filter((t) => t.result === 'loss').length;
    const totalProfit = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const totalLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
    const winRate = totalTrades ? (wins / totalTrades) * 100 : 0;
    const lossRate = totalTrades ? (losses / totalTrades) * 100 : 0;

    const now = Math.floor(Date.now() / 1000);
    const sumSince = (since) => trades.filter((t) => t.closed_at >= since).reduce((a, t) => a + t.pnl, 0);

    const latestSignals = await db.all('SELECT * FROM ai_signals ORDER BY created_at DESC LIMIT 10');
    const aiSettings = await db.get('SELECT * FROM ai_settings WHERE id = 1');
    const notifRow = await db.get(
      'SELECT COUNT(*) as c FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND is_read = 0',
      [userId]
    );

    // Scanner / connection status (requirement: dashboard must surface these)
    const scannerState = await db.get('SELECT * FROM scanner_state WHERE id = 1');
    const symbolCountRow = await db.get('SELECT COUNT(*) as c FROM scanner_symbols');
    const verifiedAccountCount = accounts.filter((a) => a.is_verified).length;

    res.json({
      accounts,
      openPositions,
      openOrders,
      totalTrades,
      wins,
      losses,
      winRate,
      lossRate,
      totalProfit,
      totalLoss,
      roi: totalLoss > 0 ? ((totalProfit - totalLoss) / totalLoss) * 100 : totalProfit > 0 ? 100 : 0,
      todayProfit: sumSince(now - 86400),
      weeklyProfit: sumSince(now - 7 * 86400),
      monthlyProfit: sumSince(now - 30 * 86400),
      latestSignals,
      aiEnabled: !!aiSettings?.enabled,
      unreadNotifications: notifRow?.c || 0,
      serverStatus: 'online',
      botStatus: aiSettings?.enabled ? 'running' : 'stopped',
      apiConnected: verifiedAccountCount > 0,
      scannerStatus: scannerState?.status || 'idle',
      totalPairsScanned: symbolCountRow?.c || 0,
      lastScanAt: scannerState?.last_scan_at || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
