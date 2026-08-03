const WebSocket = require('ws');
const axios = require('axios');
const cryptoUtil = require('../utils/crypto');
const logger = require('../utils/logger');
const { BASE_URLS, isFutures } = require('./binanceService');

const WS_BASE = {
  spot_real: 'wss://stream.binance.com:9443',
  spot_testnet: 'wss://testnet.binance.vision',
  futures_real: 'wss://fstream.binance.com',
  futures_testnet: 'wss://stream.binancefuture.com',
};

/**
 * Keeps one shared market-data socket per symbol set for live prices, and
 * (optionally) one authenticated user-data-stream socket per connected
 * Binance account for live balance/order/position push updates.
 * Reconnects automatically with exponential backoff on any close/error.
 */
class MarketFeed {
  constructor(broadcastFn) {
    this.broadcast = broadcastFn;
    this.sockets = new Map(); // accountType -> ws
    this.prices = new Map(); // symbol -> last price
  }

  start(accountType, symbols) {
    this._connectMiniTicker(accountType, symbols, 1000);
  }

  _connectMiniTicker(accountType, symbols, backoff) {
    const base = WS_BASE[accountType] || WS_BASE.spot_real;
    const streams = symbols.map((s) => `${s.toLowerCase()}@ticker`).join('/');
    const url = `${base}/stream?streams=${streams}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      logger.error('ws', `Failed to open market socket: ${e.message}`);
      return this._scheduleReconnect(accountType, symbols, backoff);
    }

    ws.on('open', () => {
      logger.info('ws', `Market feed connected (${accountType})`);
      backoff = 1000;
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        const d = msg.data;
        if (!d || !d.s) return;
        this.prices.set(d.s, { price: parseFloat(d.c), change: parseFloat(d.P), volume: parseFloat(d.v) });
        this.broadcast({ type: 'ticker', symbol: d.s, price: parseFloat(d.c), change: parseFloat(d.P), volume: parseFloat(d.v) });
      } catch (e) {
        logger.error('ws', `Bad market message: ${e.message}`);
      }
    });

    ws.on('close', () => {
      logger.warn('ws', `Market feed closed (${accountType}), reconnecting...`);
      this._scheduleReconnect(accountType, symbols, backoff);
    });

    ws.on('error', (e) => {
      logger.error('ws', `Market feed error: ${e.message}`);
      ws.close();
    });

    this.sockets.set(accountType, ws);
  }

  _scheduleReconnect(accountType, symbols, backoff) {
    const next = Math.min(backoff * 2, 30000);
    setTimeout(() => this._connectMiniTicker(accountType, symbols, next), backoff);
  }

  getPrice(symbol) {
    return this.prices.get(symbol);
  }
}

/**
 * Handles a single user's authenticated user-data-stream (requires a listenKey
 * obtained via REST, kept alive with periodic PUT requests).
 */
class UserDataStream {
  constructor({ accountId, accountType, apiKeyEnc, apiSecretEnc, onUpdate }) {
    this.accountId = accountId;
    this.accountType = accountType;
    this.apiKey = cryptoUtil.decrypt(apiKeyEnc);
    this.onUpdate = onUpdate;
    this.listenKey = null;
    this.ws = null;
    this.keepAliveTimer = null;
    this.backoff = 1000;
  }

  get restBase() {
    return BASE_URLS[this.accountType];
  }

  get listenKeyPath() {
    return isFutures(this.accountType) ? '/fapi/v1/listenKey' : '/api/v3/userDataStream';
  }

  async start() {
    try {
      const res = await axios.post(`${this.restBase}${this.listenKeyPath}`, null, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 10000,
      });
      this.listenKey = res.data.listenKey;
      this._connect();
      this._scheduleKeepAlive();
    } catch (e) {
      logger.error('ws', `Could not obtain listenKey for account ${this.accountId}: ${e.message}`);
      setTimeout(() => this.start(), 15000);
    }
  }

  _connect() {
    const base = WS_BASE[this.accountType];
    this.ws = new WebSocket(`${base}/ws/${this.listenKey}`);

    this.ws.on('open', () => {
      logger.info('ws', `User data stream connected for account ${this.accountId}`);
      this.backoff = 1000;
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this.onUpdate(msg);
      } catch (e) {
        logger.error('ws', `Bad user-data message: ${e.message}`);
      }
    });

    this.ws.on('close', () => {
      logger.warn('ws', `User data stream closed for account ${this.accountId}, reconnecting...`);
      clearInterval(this.keepAliveTimer);
      const wait = Math.min(this.backoff * 2, 30000);
      this.backoff = wait;
      setTimeout(() => this.start(), wait);
    });

    this.ws.on('error', (e) => {
      logger.error('ws', `User data stream error (account ${this.accountId}): ${e.message}`);
      this.ws.close();
    });
  }

  _scheduleKeepAlive() {
    this.keepAliveTimer = setInterval(async () => {
      try {
        await axios.put(`${this.restBase}${this.listenKeyPath}`, null, {
          params: { listenKey: this.listenKey },
          headers: { 'X-MBX-APIKEY': this.apiKey },
          timeout: 10000,
        });
      } catch (e) {
        logger.error('ws', `Keep-alive failed for account ${this.accountId}: ${e.message}`);
      }
    }, 30 * 60 * 1000); // every 30 minutes per Binance docs
  }

  stop() {
    clearInterval(this.keepAliveTimer);
    if (this.ws) this.ws.close();
  }
}

module.exports = { MarketFeed, UserDataStream };
