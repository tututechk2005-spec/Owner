'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth/middleware');
const { buildClient } = require('../binance/binanceService');

const router = express.Router();
router.use(requireAuth);

async function loadAccount(req, res) {
  const accountId = req.body.accountId || req.query.accountId;
  const account = await db.get(
    'SELECT * FROM binance_accounts WHERE id = ? AND user_id = ?',
    [accountId, req.user.id]
  );
  if (!account) res.status(404).json({ error: 'Binance account not found or not owned by you' });
  return account;
}

router.post('/manual/order', async (req, res) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return;
    const { symbol, side, type = 'MARKET', quantity, price, stopLoss, takeProfit } = req.body;
    if (!symbol || !side || !quantity) return res.status(400).json({ error: 'symbol, side and quantity are required' });

    const client = buildClient(account.account_type, account.api_key_enc, account.api_secret_enc);
    const params = { symbol, side, type, quantity };
    if (type === 'LIMIT') { params.price = price; params.timeInForce = 'GTC'; }
    const order = await client.placeOrder(params);

    await db.run(
      `INSERT INTO orders (user_id, account_id, binance_order_id, symbol, side, type, price, quantity, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'filled', 'manual')`,
      [req.user.id, account.id, order.orderId?.toString(), symbol, side, type, price || null, quantity]
    );

    if (stopLoss || takeProfit) {
      await db.run(
        `INSERT INTO positions (user_id, account_id, symbol, side, entry_price, quantity, stop_loss, take_profit, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        [req.user.id, account.id, symbol, side === 'BUY' ? 'long' : 'short', price || null, quantity, stopLoss || null, takeProfit || null]
      );
    }

    res.json({ ok: true, order });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/manual/close/:positionId', async (req, res) => {
  try {
    const position = await db.get(
      'SELECT * FROM positions WHERE id = ? AND user_id = ?',
      [req.params.positionId, req.user.id]
    );
    if (!position) return res.status(404).json({ error: 'Position not found' });
    const account = await db.get('SELECT * FROM binance_accounts WHERE id = ?', [position.account_id]);

    const client = buildClient(account.account_type, account.api_key_enc, account.api_secret_enc);
    const side = position.side === 'long' ? 'SELL' : 'BUY';
    await client.placeOrder({ symbol: position.symbol, side, type: 'MARKET', quantity: position.quantity });
    await db.run(
      "UPDATE positions SET status = 'closed', closed_at = strftime('%s','now') WHERE id = ?",
      [position.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/positions', async (req, res) => {
  try {
    const positions = await db.all(
      "SELECT * FROM positions WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC",
      [req.user.id]
    );
    res.json({ positions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders', async (req, res) => {
  try {
    const orders = await db.all(
      'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
      [req.user.id]
    );
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/auto/toggle', async (req, res) => {
  try {
    const { accountId, enabled } = req.body;
    const account = await db.get(
      'SELECT * FROM binance_accounts WHERE id = ? AND user_id = ?',
      [accountId, req.user.id]
    );
    if (!account) return res.status(404).json({ error: 'Account not found' });
    await db.run('UPDATE binance_accounts SET is_active = ? WHERE id = ?', [enabled ? 1 : 0, accountId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
