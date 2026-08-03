'use strict';
const crypto = require('crypto');
const axios = require('axios');
const cryptoUtil = require('../utils/crypto');
const logger = require('../utils/logger');

const BASE_URLS = {
  spot_real: 'https://api.binance.com',
  spot_testnet: 'https://testnet.binance.vision',
  futures_real: 'https://fapi.binance.com',
  futures_testnet: 'https://testnet.binancefuture.com',
};

function isFutures(accountType) {
  return accountType === 'futures_real' || accountType === 'futures_testnet';
}

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// ---------------------------------------------------------------------------
// Server-time synchronization
// ---------------------------------------------------------------------------
// Binance rejects signed requests whose `timestamp` differs from the
// server's clock by more than `recvWindow`. Container/VM clocks (Railway,
// Docker, etc.) frequently drift by a second or more, which surfaces as
// -1021 "Timestamp for this request is outside of the recvWindow" and looks
// like the API key itself is broken. To fix this for good, we keep a
// per-base-URL offset (serverTime - localTime), refresh it periodically in
// the background, and apply it to every signed request's timestamp.
const TIME_SYNC_TTL_MS = 5 * 60 * 1000; // resync at most every 5 minutes
const timeSyncState = new Map(); // baseUrl -> { offset, syncedAt }

async function fetchServerTime(baseUrl, futures) {
  const path = futures ? '/fapi/v1/time' : '/api/v3/time';
  const started = Date.now();
  const res = await axios.get(`${baseUrl}${path}`, { timeout: 8000 });
  // Round-trip latency correction: assume the server timestamp was captured
  // roughly midway through our request, so add half the round-trip time.
  const rtt = Date.now() - started;
  const serverTime = res.data.serverTime + Math.round(rtt / 2);
  return serverTime - Date.now();
}

async function getTimeOffset(baseUrl, futures) {
  const cached = timeSyncState.get(baseUrl);
  const now = Date.now();
  if (cached && (now - cached.syncedAt) < TIME_SYNC_TTL_MS) {
    return cached.offset;
  }
  try {
    const offset = await fetchServerTime(baseUrl, futures);
    timeSyncState.set(baseUrl, { offset, syncedAt: now });
    logger.info('binance', `Time sync OK for ${baseUrl} - offset ${offset}ms`);
    return offset;
  } catch (e) {
    // If we can't reach Binance to sync, fall back to the last known
    // offset (or 0) rather than failing the whole request outright -
    // the actual request below will surface a proper network error if
    // Binance is truly unreachable.
    logger.warn('binance', `Time sync failed for ${baseUrl}: ${e.message} - using last known offset`);
    return cached ? cached.offset : 0;
  }
}

/** Forces an immediate resync, used as a one-shot retry after a -1021 error. */
async function forceResync(baseUrl, futures) {
  const offset = await fetchServerTime(baseUrl, futures);
  timeSyncState.set(baseUrl, { offset, syncedAt: Date.now() });
  logger.info('binance', `Forced time resync for ${baseUrl} - new offset ${offset}ms`);
  return offset;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------
function classifyError(err) {
  const code = err.binanceCode;
  const status = err.status;

  if (code === -2014) return 'invalid_api_key';        // API-key format invalid
  if (code === -2015) return 'invalid_api_key';        // Invalid API-key, IP, or permissions
  if (code === -1022) return 'invalid_secret';          // Signature for this request is not valid
  if (code === -1021) return 'clock_skew';              // Timestamp outside of recvWindow
  if (code === -2010) return 'missing_permissions';
  if (code === -1102 || code === -1104) return 'missing_permissions';
  if (status === 403) return 'missing_permissions';
  if (status === 418 || status === 429) return 'rate_limited';
  if (status >= 500) return 'binance_server_error';
  if (status === 401) return 'invalid_api_key';
  return 'unknown_error';
}

function hintForError(err, errorType, accountType) {
  const isFuturesAcct = accountType && accountType.startsWith('futures');
  switch (errorType) {
    case 'invalid_api_key':
      return 'The API key was rejected by Binance ("Invalid API-key, IP, or permissions" / "API-key format invalid"). Double check you copied it exactly with no extra spaces, and that it belongs to the correct account (Testnet keys only work on Testnet, Real keys only work on Real). If you set an IP restriction on the key, make sure this server\'s outbound IP is whitelisted.';
    case 'invalid_secret':
      return 'The API secret does not match the API key ("Signature for this request is not valid"). Re-copy the secret exactly - Binance only shows it once when the key is created.';
    case 'missing_permissions':
      return isFuturesAcct
        ? 'This API key does not have Futures trading permission enabled ("Permission denied"). On Binance, edit the API key and enable "Enable Futures" under API restrictions.'
        : 'This API key does not have the required Spot permission enabled ("Permission denied"). On Binance, edit the API key and enable "Enable Reading" and "Enable Spot & Margin Trading".';
    case 'clock_skew':
      return 'Server clock drift caused a "Timestamp for this request is outside of the recvWindow" error. The client automatically re-synchronizes with Binance server time and retries once - if you still see this repeatedly, the host machine\'s clock may be drifting significantly.';
    case 'rate_limited':
      return 'Binance is rate-limiting this request (HTTP 418/429). Wait a short while before retrying.';
    case 'network_timeout':
      return 'The request to Binance timed out. This was retried automatically; if it keeps happening, check your network connection.';
    case 'network_error':
      return 'Could not reach Binance servers. This was retried automatically; check your network connection or the Binance status page.';
    case 'binance_server_error':
      return 'Binance is currently experiencing server issues (5xx). This was retried automatically and is not caused by your API key.';
    default:
      return 'Verify the API key/secret, account type (spot/futures, testnet/real), and required permissions (read + trade).';
  }
}

/** Redacts sensitive values before anything gets logged. */
function redactForLog(method, path, params) {
  const safeParams = { ...params };
  delete safeParams.signature;
  const q = new URLSearchParams(safeParams).toString();
  return `${method} ${path}${q ? '?' + q : ''}`;
}

const RETRYABLE_ERROR_TYPES = new Set(['network_error', 'network_timeout', 'binance_server_error']);
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin wrapper around the Binance REST API. Every call takes the decrypted
 * apiKey/apiSecret pair for the account so we never keep long-lived clients
 * with credentials in memory longer than a single request.
 */
class BinanceClient {
  constructor(accountType, apiKey, apiSecret) {
    if (!BASE_URLS[accountType]) throw new Error(`Unknown account type: ${accountType}`);
    this.accountType = accountType;
    this.baseUrl = BASE_URLS[accountType];
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.futures = isFutures(accountType);
  }

  async _signedQuery(params) {
    const offset = await getTimeOffset(this.baseUrl, this.futures);
    const query = new URLSearchParams(params);
    query.set('timestamp', (Date.now() + offset).toString());
    query.set('recvWindow', '10000');
    const signature = sign(query.toString(), this.apiSecret);
    query.set('signature', signature);
    return query;
  }

  async _doRequest(method, path, params, signed) {
    const query = signed ? await this._signedQuery(params) : new URLSearchParams(params);
    const url = `${this.baseUrl}${path}${query.toString() ? '?' + query.toString() : ''}`;
    const res = await axios({
      method,
      url,
      headers: this.apiKey ? { 'X-MBX-APIKEY': this.apiKey } : {},
      timeout: 15000,
    });
    return res.data;
  }

  /**
   * Executes a request with automatic retry for transient failures
   * (network errors, timeouts, Binance 5xx) and a single forced
   * time-resync-and-retry specifically for -1021 timestamp errors.
   * Never retries genuine client errors (bad key, bad signature, bad
   * params) since retrying those only wastes time and risks rate limits.
   */
  async request(method, path, params = {}, signed = false) {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await this._doRequest(method, path, params, signed);
        logger.info('binance', `${redactForLog(method, path, params)} -> 200 OK`);
        return data;
      } catch (err) {
        const wrapped = this._wrapError(err);
        lastErr = wrapped;
        logger.error('binance', `${redactForLog(method, path, params)} -> ${wrapped.errorType} (${wrapped.message})`);

        // Timestamp drift: force an immediate resync and retry right away,
        // without counting it against the standard retry budget below.
        if (wrapped.errorType === 'clock_skew' && attempt === 0) {
          try {
            await forceResync(this.baseUrl, this.futures);
            continue;
          } catch (_) {
            // fall through to normal retry/throw handling
          }
        }

        const canRetry = RETRYABLE_ERROR_TYPES.has(wrapped.errorType) && attempt < MAX_RETRIES;
        if (!canRetry) throw wrapped;

        const delay = RETRY_BASE_DELAY_MS * Math.pow(3, attempt);
        logger.warn('binance', `Retrying ${method} ${path} after ${wrapped.errorType} (attempt ${attempt + 1}/${MAX_RETRIES}), waiting ${delay}ms`);
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  _wrapError(err) {
    if (!err.response) {
      const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
      const e = new Error(isTimeout ? 'Network timeout - Binance did not respond in time' : `Network error contacting Binance: ${err.message}`);
      e.errorType = isTimeout ? 'network_timeout' : 'network_error';
      e.status = null;
      return e;
    }
    const detail = err.response.data || { msg: err.message };
    const e = new Error(detail.msg || 'Binance API request failed');
    e.binanceCode = detail.code;
    e.status = err.response.status;
    e.errorType = classifyError(e);
    return e;
  }

  // ---- Public/market data --------------------------------------------------
  ping() {
    return this.request('GET', this.futures ? '/fapi/v1/ping' : '/api/v3/ping');
  }

  serverTime() {
    return this.request('GET', this.futures ? '/fapi/v1/time' : '/api/v3/time');
  }

  klines(symbol, interval, limit = 200) {
    const path = this.futures ? '/fapi/v1/klines' : '/api/v3/klines';
    return this.request('GET', path, { symbol, interval, limit });
  }

  ticker24hr(symbol) {
    const path = this.futures ? '/fapi/v1/ticker/24hr' : '/api/v3/ticker/24hr';
    return this.request('GET', path, symbol ? { symbol } : {});
  }

  exchangeInfo() {
    const path = this.futures ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
    return this.request('GET', path);
  }

  /**
   * Returns every tradable USDT-margined perpetual futures symbol, skipping
   * anything suspended, delisted, or not yet trading. Used by the scanner to
   * build its dynamic symbol list instead of a hardcoded one.
   */
  async fetchFuturesUSDTPerpetuals() {
    const info = await this.request('GET', '/fapi/v1/exchangeInfo');
    const symbols = (info.symbols || []).filter((s) =>
      s.quoteAsset === 'USDT' &&
      s.contractType === 'PERPETUAL' &&
      s.status === 'TRADING'
    );
    return symbols.map((s) => ({ symbol: s.symbol, status: s.status, contractType: s.contractType }));
  }

  // ---- Account / private ----------------------------------------------------
  // Futures account/position-risk use the current v3 endpoints per Binance's
  // latest USDS-M Futures docs (v2 remains available but v3 is the current
  // documented version); balance has no v3 counterpart so v2 stays current.
  accountInfo() {
    const path = this.futures ? '/fapi/v3/account' : '/api/v3/account';
    return this.request('GET', path, {}, true);
  }

  balances() {
    if (this.futures) return this.request('GET', '/fapi/v2/balance', {}, true);
    return this.accountInfo().then((a) => a.balances);
  }

  openOrders(symbol) {
    const path = this.futures ? '/fapi/v1/openOrders' : '/api/v3/openOrders';
    return this.request('GET', path, symbol ? { symbol } : {}, true);
  }

  positionRisk(symbol) {
    if (!this.futures) return Promise.resolve([]);
    return this.request('GET', '/fapi/v3/positionRisk', symbol ? { symbol } : {}, true);
  }

  /** Returns whether the futures account is in Hedge Mode (dual) or One-way Mode. */
  positionMode() {
    if (!this.futures) return Promise.resolve(null);
    return this.request('GET', '/fapi/v1/positionSide/dual', {}, true);
  }

  myTrades(symbol, limit = 50) {
    const path = this.futures ? '/fapi/v1/userTrades' : '/api/v3/myTrades';
    return this.request('GET', path, { symbol, limit }, true);
  }

  // ---- Trading ---------------------------------------------------------------
  placeOrder(params) {
    const path = this.futures ? '/fapi/v1/order' : '/api/v3/order';
    return this.request('POST', path, params, true);
  }

  cancelOrder(symbol, orderId) {
    const path = this.futures ? '/fapi/v1/order' : '/api/v3/order';
    return this.request('DELETE', path, { symbol, orderId }, true);
  }

  changeLeverage(symbol, leverage) {
    if (!this.futures) return Promise.resolve(null);
    return this.request('POST', '/fapi/v1/leverage', { symbol, leverage }, true);
  }

  /**
   * Builds the full post-connection snapshot requested after a successful
   * validation: balance, futures balance, account status, position mode,
   * and per-symbol leverage (derived from open positions' leverage field).
   * Each piece is fetched independently so one failing call (e.g. an
   * account with no futures permission) doesn't blank out the rest.
   */
  async getAccountSnapshot() {
    const snapshot = { accountType: this.accountType, futures: this.futures };

    const account = await this.accountInfo();
    snapshot.status = {
      canTrade: !!account.canTrade,
      canDeposit: !!account.canDeposit,
      canWithdraw: !!account.canWithdraw,
    };

    if (this.futures) {
      snapshot.futuresBalance = {
        totalWalletBalance: account.totalWalletBalance,
        totalMarginBalance: account.totalMarginBalance,
        availableBalance: account.availableBalance,
        totalUnrealizedProfit: account.totalUnrealizedProfit,
      };
      try {
        const mode = await this.positionMode();
        snapshot.positionMode = mode?.dualSidePosition ? 'Hedge Mode' : 'One-way Mode';
      } catch (e) {
        snapshot.positionMode = `Unavailable (${e.message})`;
      }
      try {
        const positions = await this.positionRisk();
        snapshot.leverage = (positions || [])
          .filter((p) => parseFloat(p.positionAmt) !== 0 || parseFloat(p.leverage) > 0)
          .map((p) => ({ symbol: p.symbol, leverage: p.leverage, positionAmt: p.positionAmt }))
          .slice(0, 20);
      } catch (e) {
        snapshot.leverage = [];
      }
    } else {
      snapshot.balance = (account.balances || []).filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
    }

    return snapshot;
  }

  // ---- Validation --------------------------------------------------------
  async validateKeys() {
    logger.info('binance', `Validating ${this.accountType} API keys...`);
    try {
      await this.ping();
      const account = await this.accountInfo();

      // Explicit permission check: Binance can return HTTP 200 with trading
      // disabled on the key/account rather than a distinct error code, so
      // we surface that as a clear "missing_permissions" failure instead of
      // reporting a false "connected successfully".
      if (account.canTrade === false) {
        const e = new Error(
          this.futures
            ? 'API key is valid but Futures trading is not enabled for this account/key.'
            : 'API key is valid but Spot & Margin trading is not enabled for this account/key.'
        );
        e.errorType = 'missing_permissions';
        throw e;
      }

      let snapshot = null;
      try {
        snapshot = await this.getAccountSnapshot();
      } catch (e) {
        // Validation itself still succeeded (account fetch above worked);
        // the snapshot is best-effort extra detail, not a hard requirement.
        logger.warn('binance', `Account snapshot partially failed: ${e.message}`);
      }

      logger.info('binance', `Validation SUCCESS for ${this.accountType}`);
      return { ok: true, account, snapshot };
    } catch (err) {
      const errorType = err.errorType || classifyError(err);
      const hint = hintForError(err, errorType, this.accountType);
      logger.error('binance', `Validation FAILED for ${this.accountType}: [${errorType}] ${err.message}`);
      return {
        ok: false,
        error: err.message,
        errorType,
        code: err.binanceCode,
        httpStatus: err.status,
        hint,
      };
    }
  }
}

function buildClient(accountType, encApiKey, encApiSecret) {
  const apiKey = cryptoUtil.decrypt(encApiKey);
  const apiSecret = cryptoUtil.decrypt(encApiSecret);
  return new BinanceClient(accountType, apiKey, apiSecret);
}

module.exports = { BinanceClient, buildClient, BASE_URLS, isFutures, classifyError, hintForError };
