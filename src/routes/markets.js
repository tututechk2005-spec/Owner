'use strict';
const express = require('express');
const { BinanceClient } = require('../binance/binanceService');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

const publicClient = new BinanceClient('spot_real', null, null);

router.get('/tickers', async (req, res) => {
  try {
    const data = await publicClient.ticker24hr();
    const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT'];
    const filtered = Array.isArray(data) ? data.filter((d) => symbols.includes(d.symbol)) : [];
    res.json({ tickers: filtered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/klines/:symbol/:interval', async (req, res) => {
  try {
    const { symbol, interval } = req.params;
    const data = await publicClient.klines(symbol, interval, 200);
    res.json({ klines: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
