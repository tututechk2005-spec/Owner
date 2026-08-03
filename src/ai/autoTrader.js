'use strict';
const db = require('../db');
const logger = require('../utils/logger');
const { buildClient, BinanceClient } = require('../binance/binanceService');
const { analyzeTimeframe, buildConfluence, persistSignal, persistRejectedSignal, REQUIRED_MTF } = require('./signalEngine');
const { notifySignal, notifyTradeClosed } = require('../notify/telegram');

function toCandles(klines) {
  return klines.map((k) => ({
    openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

class AutoTrader {
  constructor(broadcastFn) {
    this.broadcast = broadcastFn || (() => {});
    this.running = false;
    this.timer = null;
    this.symbolRefreshInFlight = false;
    // Guards against overlapping scan cycles (e.g. a slow cycle plus a
    // timer firing) which would otherwise open duplicate WS/HTTP work.
    this.scanInFlight = false;
  }

  start() {
    if (this.running) {
      logger.warn('autotrader', 'start() called while already running - ignoring duplicate start');
      return;
    }
    this.running = true;
    this._loop();
    this._scheduleCleanup();
    logger.info('autotrader', 'AI auto-trading engine started');
  }

  /**
   * Prunes old logs/rejected-signals/stale cooldown rows every hour so
   * long-running deployments don't grow the SQLite file or in-memory
   * query results without bound.
   */
  _scheduleCleanup() {
    const clean = async () => {
      try {
        await db.run("DELETE FROM logs WHERE created_at < strftime('%s','now','-7 days')");
        await db.run("DELETE FROM ai_signals WHERE status = 'rejected' AND created_at < strftime('%s','now','-3 days')");
        await db.run("DELETE FROM ai_signals WHERE status = 'new' AND created_at < strftime('%s','now','-1 day')");
        logger.info('autotrader', 'Retention cleanup completed');
      } catch (e) {
        logger.error('autotrader', `Retention cleanup failed: ${e.message}`);
      }
    };
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = setInterval(clean, 60 * 60 * 1000);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.timer = null;
    this.cleanupTimer = null;
  }

  _loop() {
    if (!this.running) return;
    db.get('SELECT * FROM ai_settings WHERE id = 1').then((settings) => {
      const interval = settings?.scan_interval_ms || 15000;
      if (this.scanInFlight) {
        // Previous cycle still running - skip this tick rather than
        // stacking overlapping scans (prevents duplicate connections/leaks).
        this.timer = setTimeout(() => this._loop(), interval);
        return;
      }
      this.scanInFlight = true;
      this.scanOnce()
        .catch((e) => logger.error('autotrader', `Scan cycle failed: ${e.message}`))
        .finally(() => {
          this.scanInFlight = false;
          this.timer = setTimeout(() => this._loop(), interval);
        });
    }).catch((e) => {
      logger.error('autotrader', `Failed to read ai_settings: ${e.message}`);
      this.timer = setTimeout(() => this._loop(), 15000);
    });
  }

  /**
   * Refreshes the dynamic Futures USDT-perpetual symbol list from Binance,
   * skipping anything suspended/delisted, storing it in scanner_symbols.
   * Only re-fetches when the configured refresh interval has elapsed.
   */
  async refreshSymbolsIfNeeded(settings) {
    if (this.symbolRefreshInFlight) return;
    const state = await db.get('SELECT * FROM scanner_state WHERE id = 1');
    const refreshInterval = settings.symbol_refresh_interval_ms || 1800000;
    const now = Date.now();
    if (state?.last_symbol_refresh && (now - state.last_symbol_refresh) < refreshInterval) return;

    this.symbolRefreshInFlight = true;
    try {
      const client = new BinanceClient('futures_real', null, null);
      const pairs = await client.fetchFuturesUSDTPerpetuals();
      logger.info('scanner', `Refreshed symbol list: ${pairs.length} tradable USDT perpetual pairs found`);

      // Replace the symbol table contents
      await db.run('DELETE FROM scanner_symbols');
      for (const p of pairs) {
        await db.run(
          'INSERT OR REPLACE INTO scanner_symbols (symbol, status, contract_type, updated_at) VALUES (?, ?, ?, strftime(\'%s\',\'now\'))',
          [p.symbol, p.status, p.contractType]
        );
      }
      await db.run(
        `UPDATE scanner_state SET total_pairs = ?, last_symbol_refresh = ? WHERE id = 1`,
        [pairs.length, now]
      );
    } catch (e) {
      logger.error('scanner', `Symbol refresh failed: ${e.message}`);
    } finally {
      this.symbolRefreshInFlight = false;
    }
  }

  /**
   * Returns the next batch of symbols to scan this cycle. Scanning all
   * 200+ Futures USDT pairs across 4 timeframes every cycle would mean
   * 800+ API calls per tick and would hit Binance rate limits almost
   * immediately - instead this round-robins through the full list in
   * fixed-size batches, so every symbol gets scanned regularly without
   * overloading the API.
   */
  async getNextBatch(settings) {
    const batchSize = settings.symbols_per_cycle || 10;

    if (!settings.use_dynamic_symbols) {
      const list = (settings.symbols || 'BTCUSDT').split(',').map((s) => s.trim()).filter(Boolean);
      return list;
    }

    const all = await db.all('SELECT symbol FROM scanner_symbols ORDER BY symbol ASC');
    if (!all.length) {
      // Symbol list not populated yet - fall back to the static list for this cycle
      return (settings.symbols || 'BTCUSDT').split(',').map((s) => s.trim()).filter(Boolean);
    }

    const state = await db.get('SELECT * FROM scanner_state WHERE id = 1');
    let pos = state?.cycle_position || 0;
    const batch = [];
    for (let i = 0; i < batchSize && i < all.length; i++) {
      batch.push(all[(pos + i) % all.length].symbol);
    }
    const nextPos = (pos + batchSize) % all.length;
    await db.run('UPDATE scanner_state SET cycle_position = ?, last_scan_batch = ? WHERE id = 1', [nextPos, batch.join(',')]);
    return batch;
  }

  async scanOnce() {
    const settings = await db.get('SELECT * FROM ai_settings WHERE id = 1');
    if (!settings || !settings.enabled) {
      await db.run("UPDATE scanner_state SET status = 'disabled' WHERE id = 1");
      return;
    }

    await db.run("UPDATE scanner_state SET status = 'scanning' WHERE id = 1");

    if (settings.use_dynamic_symbols) {
      await this.refreshSymbolsIfNeeded(settings);
    }

    const timeframes = (settings.timeframes || REQUIRED_MTF.join(',')).split(',').map((s) => s.trim());
    const minConfidence = settings.min_confidence || 85;
    const minRR = settings.min_risk_reward || 2;
    const cooldownMs = settings.signal_cooldown_ms || 900000;

    const batch = await this.getNextBatch(settings);
    logger.info('scanner', `Scanning batch of ${batch.length} symbols: ${batch.join(', ')}`);

    for (const symbol of batch) {
      await this._analyzeSymbol(symbol, timeframes, minConfidence, minRR, cooldownMs);
    }

    await db.run("UPDATE scanner_state SET status = 'idle', last_scan_at = strftime('%s','now') WHERE id = 1");

    const accounts = await db.all(
      `SELECT ba.*, ba.user_id as user_id FROM binance_accounts ba
       JOIN users u ON u.id = ba.user_id
       WHERE ba.is_active = 1 AND ba.is_verified = 1`
    );

    for (const account of accounts) {
      try {
        await this._processAccount(account, batch, minConfidence, minRR);
      } catch (e) {
        logger.error('autotrader', `Account ${account.id} error: ${e.message}`);
      }
    }
  }

  /** Checks (and updates) the per-symbol cooldown to prevent duplicate signals. */
  async checkCooldown(symbol, direction, confidence, cooldownMs) {
    const row = await db.get('SELECT * FROM signal_cooldowns WHERE symbol = ?', [symbol]);
    const now = Date.now();
    if (row && row.last_direction === direction && (now - row.last_signal_at) < cooldownMs) {
      return { onCooldown: true, remainingMs: cooldownMs - (now - row.last_signal_at) };
    }
    await db.run(
      `INSERT INTO signal_cooldowns (symbol, last_direction, last_signal_at, last_confidence)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET last_direction = excluded.last_direction,
         last_signal_at = excluded.last_signal_at, last_confidence = excluded.last_confidence`,
      [symbol, direction, now, confidence]
    );
    return { onCooldown: false };
  }

  async _analyzeSymbol(symbol, timeframes, minConfidence, minRR, cooldownMs) {
    try {
      const client = new BinanceClient('futures_real', null, null);
      const tfResults = {};
      for (const tf of timeframes) {
        try {
          const kl = await client.klines(symbol, tf, 200);
          tfResults[tf] = analyzeTimeframe(toCandles(kl));
        } catch (e) {
          logger.warn('scanner', `Kline fetch failed for ${symbol} ${tf}: ${e.message}`);
          tfResults[tf] = null;
        }
      }

      const confluence = buildConfluence(tfResults, minRR);

      if (confluence.rejected) {
        await persistRejectedSignal(symbol, timeframes.join(','), confluence.reason);
        return null;
      }

      if (confluence.confidence < minConfidence) {
        await persistRejectedSignal(symbol, 'multi', `Confidence ${confluence.confidence}% below minimum ${minConfidence}%`);
        return null;
      }
      if (confluence.riskReward < minRR) {
        await persistRejectedSignal(symbol, 'multi', `Risk:Reward ${confluence.riskReward.toFixed(2)} below minimum ${minRR}`);
        return null;
      }
      if (!confluence.trendConfirmed || !confluence.volumeConfirmed || !confluence.momentumConfirmed || !confluence.structureConfirmed) {
        await persistRejectedSignal(symbol, 'multi', 'Missing one or more required confirmations (trend/volume/momentum/structure)');
        return null;
      }

      // Duplicate-signal protection: never re-fire the same direction on
      // the same symbol within the cooldown window.
      const cooldown = await this.checkCooldown(symbol, confluence.direction, confluence.confidence, cooldownMs);
      if (cooldown.onCooldown) {
        logger.info('scanner', `${symbol} ${confluence.direction} signal skipped - on cooldown for ${Math.round(cooldown.remainingMs / 1000)}s more`);
        return null;
      }

      const signalId = await persistSignal(symbol, 'multi', confluence);

      this.broadcast({
        type: 'signal', symbol,
        direction: confluence.direction,
        confidence: confluence.confidence,
        riskReward: confluence.riskReward,
        signalId,
      });

      // Telegram alert - never sent twice for the same signal (guarded by
      // telegram_sent flag + the cooldown above already prevents duplicates
      // at the source).
      const tgResult = await notifySignal({
        symbol, direction: confluence.direction, confidence: confluence.confidence,
        riskReward: confluence.riskReward, price: confluence.primary.price,
        stopLoss: confluence.stopLoss, takeProfit: confluence.takeProfit,
        reasons: confluence.reasons,
      });
      if (tgResult.ok) {
        await db.run('UPDATE ai_signals SET telegram_sent = 1 WHERE id = ?', [signalId]);
      }

      return confluence;
    } catch (e) {
      logger.error('scanner', `Analysis failed for ${symbol}: ${e.message}`);
      return null;
    }
  }

  async _processAccount(account, symbols, minConfidence, minRR) {
    const risk = await db.get('SELECT * FROM risk_settings WHERE id = 1');
    const client = buildClient(account.account_type, account.api_key_enc, account.api_secret_enc);

    const openPositions = await db.all(
      "SELECT * FROM positions WHERE account_id = ? AND status = 'open'",
      [account.id]
    );

    for (const pos of openPositions) {
      await this._managePosition(client, account, pos, risk);
    }

    const stillOpenRow = await db.get(
      "SELECT COUNT(*) as c FROM positions WHERE account_id = ? AND status = 'open'",
      [account.id]
    );
    if ((stillOpenRow?.c || 0) >= (risk?.max_open_positions || 3)) return;

    for (const symbol of symbols) {
      // Never open a duplicate trade on a symbol/account already holding a position
      const alreadyOpen = await db.get(
        "SELECT id FROM positions WHERE account_id = ? AND symbol = ? AND status = 'open'",
        [account.id, symbol]
      );
      if (alreadyOpen) continue;

      const signal = await db.get(
        "SELECT * FROM ai_signals WHERE symbol = ? AND status = 'new' ORDER BY created_at DESC LIMIT 1",
        [symbol]
      );
      if (!signal) continue;
      if (signal.confidence < minConfidence) continue;
      if (signal.risk_reward < minRR) continue;
      if (!signal.trend_confirmed || !signal.volume_confirmed || !signal.momentum_confirmed || !signal.structure_confirmed) continue;

      await this._executeTrade(client, account, signal, risk);
    }
  }

  async _executeTrade(client, account, signal, risk) {
    try {
      const indicators = JSON.parse(signal.indicators_json || '{}');
      const price = indicators.vwap || indicators.ema20 || null;
      if (!price) return;

      const side = signal.direction === 'long' ? 'BUY' : 'SELL';
      const balances = await client.balances().catch(() => []);
      const usdt = Array.isArray(balances) ? balances.find((b) => b.asset === 'USDT') : null;
      const availableUsdt = usdt ? parseFloat(usdt.availableBalance || usdt.free || 0) : 0;
      const riskAmount = availableUsdt * ((risk?.max_risk_per_trade_pct || 1) / 100);

      // Use the signal's own dynamic stop distance (structure/ATR-based)
      // rather than a fixed percentage.
      const stopDistance = Math.abs(price - (signal.stop_loss || price * 0.99));
      let quantity = stopDistance > 0 ? riskAmount / stopDistance : 0;
      if (!quantity || !isFinite(quantity)) return;

      const order = await client.placeOrder({ symbol: signal.symbol, side, type: 'MARKET', quantity: quantity.toFixed(6) });

      await db.run(
        `INSERT INTO orders (user_id, account_id, binance_order_id, symbol, side, type, price, quantity, status, source)
         VALUES (?, ?, ?, ?, ?, 'MARKET', ?, ?, 'filled', 'auto')`,
        [account.user_id, account.id, order.orderId?.toString(), signal.symbol, side, price, quantity]
      );

      await db.run(
        `INSERT INTO positions (user_id, account_id, symbol, side, entry_price, quantity, leverage, stop_loss, take_profit, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        [account.user_id, account.id, signal.symbol, signal.direction, price, quantity, risk?.default_leverage || 1, signal.stop_loss, signal.take_profit]
      );

      await db.run("UPDATE ai_signals SET status = 'executed' WHERE id = ?", [signal.id]);

      await db.run(
        `INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, 'trade')`,
        [account.user_id, 'Auto trade executed', `${side} ${signal.symbol} by AI at confidence ${signal.confidence}%`]
      );

      logger.info('autotrader', `Executed ${side} ${signal.symbol} account ${account.id} confidence ${signal.confidence}%`);
    } catch (e) {
      logger.error('autotrader', `Trade execution failed for ${signal.symbol}: ${e.message}`);
    }
  }

  async _managePosition(client, account, pos, risk) {
    try {
      const publicClient = new BinanceClient('futures_real', null, null);
      const ticker = await publicClient.ticker24hr(pos.symbol).catch(() => null);
      const currentPrice = ticker ? parseFloat(ticker.lastPrice) : null;
      if (!currentPrice) return;

      const isLong = pos.side === 'long';
      let shouldClose = false;
      if (isLong && pos.stop_loss && currentPrice <= pos.stop_loss) shouldClose = true;
      if (!isLong && pos.stop_loss && currentPrice >= pos.stop_loss) shouldClose = true;
      if (isLong && pos.take_profit && currentPrice >= pos.take_profit) shouldClose = true;
      if (!isLong && pos.take_profit && currentPrice <= pos.take_profit) shouldClose = true;

      const breakEvenTrigger = (risk?.break_even_trigger_pct || 1) / 100;
      const movedPct = isLong
        ? (currentPrice - pos.entry_price) / pos.entry_price
        : (pos.entry_price - currentPrice) / pos.entry_price;

      if (movedPct >= breakEvenTrigger && pos.stop_loss !== pos.entry_price) {
        await db.run('UPDATE positions SET stop_loss = ? WHERE id = ?', [pos.entry_price, pos.id]);
      }

      const trailPct = (risk?.trailing_stop_pct || 1) / 100;
      if (movedPct > trailPct) {
        const newStop = isLong ? currentPrice * (1 - trailPct) : currentPrice * (1 + trailPct);
        if ((isLong && newStop > pos.stop_loss) || (!isLong && newStop < pos.stop_loss)) {
          await db.run('UPDATE positions SET stop_loss = ? WHERE id = ?', [newStop, pos.id]);
        }
      }

      if (shouldClose) {
        const side = isLong ? 'SELL' : 'BUY';
        await client.placeOrder({ symbol: pos.symbol, side, type: 'MARKET', quantity: pos.quantity.toFixed(6) });
        const pnl = isLong
          ? (currentPrice - pos.entry_price) * pos.quantity
          : (pos.entry_price - currentPrice) * pos.quantity;

        await db.run(
          "UPDATE positions SET status = 'closed', pnl = ?, closed_at = strftime('%s','now') WHERE id = ?",
          [pnl, pos.id]
        );

        const result = pnl >= 0 ? 'win' : 'loss';
        await db.run(
          `INSERT INTO trade_history (user_id, account_id, symbol, side, entry_price, exit_price, quantity, pnl, result, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')`,
          [account.user_id, account.id, pos.symbol, pos.side, pos.entry_price, currentPrice, pos.quantity, pnl, result]
        );

        await db.run(
          `INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, 'trade')`,
          [account.user_id, 'Position closed', `${pos.symbol} closed PNL ${pnl.toFixed(2)}`]
        );

        await notifyTradeClosed({
          symbol: pos.symbol, side: pos.side, entryPrice: pos.entry_price,
          exitPrice: currentPrice, pnl, result,
        });

        logger.info('autotrader', `Closed position ${pos.id} (${pos.symbol}) PNL=${pnl.toFixed(2)}`);
      }
    } catch (e) {
      logger.error('autotrader', `managePosition failed pos ${pos.id}: ${e.message}`);
    }
  }
}

module.exports = AutoTrader;
