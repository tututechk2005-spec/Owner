'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth/middleware');
const { buildClient } = require('../binance/binanceService');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const accounts = await db.all(
      'SELECT * FROM binance_accounts WHERE user_id = ? AND is_verified = 1',
      [req.user.id]
    );
    const results = [];
    for (const account of accounts) {
      try {
        const client = buildClient(account.account_type, account.api_key_enc, account.api_secret_enc);
        if (account.account_type.startsWith('futures')) {
          const info = await client.accountInfo();
          results.push({
            accountId: account.id, label: account.label, type: account.account_type,
            walletBalance: parseFloat(info.totalWalletBalance || 0),
            availableBalance: parseFloat(info.availableBalance || 0),
            marginBalance: parseFloat(info.totalMarginBalance || 0),
            unrealizedPnl: parseFloat(info.totalUnrealizedProfit || 0),
          });
        } else {
          const info = await client.accountInfo();
          const nonZero = (info.balances || []).filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
          results.push({ accountId: account.id, label: account.label, type: account.account_type, balances: nonZero });
        }
      } catch (e) {
        results.push({ accountId: account.id, label: account.label, type: account.account_type, error: e.message });
      }
    }
    const deposits = await db.all('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    const withdrawals = await db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json({ accounts: results, deposits, withdrawals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/deposit', async (req, res) => {
  const { amount, method } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  try {
    const info = await db.run(
      'INSERT INTO deposits (user_id, amount, method) VALUES (?, ?, ?)',
      [req.user.id, amount, method || 'manual']
    );
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/withdraw', async (req, res) => {
  const { amount, destination } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  try {
    const info = await db.run(
      'INSERT INTO withdrawals (user_id, amount, destination) VALUES (?, ?, ?)',
      [req.user.id, amount, destination || '']
    );
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
