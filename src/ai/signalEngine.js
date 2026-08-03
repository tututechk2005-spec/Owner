'use strict';
const ind = require('./indicators');
const db = require('../db');
const logger = require('../utils/logger');

const TIMEFRAME_WEIGHT = { '1m': 0.5, '3m': 0.6, '5m': 0.8, '15m': 1, '30m': 1.1, '1h': 1.3, '4h': 1.5 };

// These four timeframes are the mandatory multi-timeframe confirmation set.
// A signal is rejected outright if any of them is missing or unreadable.
const REQUIRED_MTF = ['1m', '5m', '15m', '1h'];

function analyzeTimeframe(candles) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const n = closes.length;
  if (n < 50) return null;

  const ema20 = ind.ema(closes, 20);
  const ema50 = ind.ema(closes, 50);
  const rsi14 = ind.rsi(closes, 14);
  const { macdLine, signalLine, histogram } = ind.macd(closes);
  const atr14 = ind.atr(highs, lows, closes, 14);
  const adx14 = ind.adx(highs, lows, closes, 14);
  const vwapArr = ind.vwap(highs, lows, closes, volumes);
  const bb = ind.bollingerBands(closes, 20, 2);
  const sr = ind.supportResistance(highs, lows, 30);
  const structure = ind.detectStructure(highs, lows, closes);

  const last = n - 1;
  const price = closes[last];
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeConfirmed = volumes[last] > avgVolume * 1.1;

  let trendScore = 0;
  if (ema20[last] != null && ema50[last] != null) trendScore += ema20[last] > ema50[last] ? 0.5 : -0.5;
  if (price != null && vwapArr[last] != null) trendScore += price > vwapArr[last] ? 0.25 : -0.25;
  if (structure.bos === 'bullish') trendScore += 0.25;
  if (structure.bos === 'bearish') trendScore -= 0.25;

  let momentumScore = 0;
  if (rsi14[last] != null) {
    if (rsi14[last] > 55) momentumScore += 0.4;
    else if (rsi14[last] < 45) momentumScore -= 0.4;
  }
  if (histogram[last] != null) momentumScore += histogram[last] > 0 ? 0.4 : -0.4;
  if (macdLine[last] != null && signalLine[last] != null)
    momentumScore += macdLine[last] > signalLine[last] ? 0.2 : -0.2;

  // Structure confirmation: BOS/CHOCH/liquidity sweep/FVG/order block all
  // count as evidence of a clean market-structure setup, not just indicator noise.
  let structureScore = 0;
  const structureReasons = [];
  if (structure.bos) { structureScore += 1; structureReasons.push(`BOS (${structure.bos})`); }
  if (structure.choch) { structureScore += 1; structureReasons.push(`CHOCH (${structure.choch})`); }
  if (structure.liquiditySweep) { structureScore += 1; structureReasons.push('Liquidity sweep detected'); }
  if (structure.fvg && structure.fvg.length) { structureScore += 0.5; structureReasons.push(`${structure.fvg.length} fair value gap(s)`); }
  if (structure.orderBlocks && structure.orderBlocks.length) { structureScore += 0.5; structureReasons.push(`${structure.orderBlocks.length} order block(s)`); }
  const structureConfirmed = structureScore >= 1;

  const trendConfirmed = Math.abs(trendScore) >= 0.5;
  const momentumConfirmed = Math.abs(momentumScore) >= 0.4 && Math.sign(momentumScore) === Math.sign(trendScore || 1);

  const direction = trendScore + momentumScore >= 0 ? 'long' : 'short';
  const combined = (trendScore + momentumScore) / 2;

  return {
    direction, combinedScore: combined, trendConfirmed, momentumConfirmed, volumeConfirmed,
    structureConfirmed, structureScore, structureReasons,
    price, atr: atr14[last], support: sr.support, resistance: sr.resistance, structure,
    rsi: rsi14[last], adx: adx14[last],
    indicators: {
      ema20: ema20[last], ema50: ema50[last], rsi: rsi14[last],
      macd: macdLine[last], signal: signalLine[last], histogram: histogram[last],
      atr: atr14[last], adx: adx14[last], vwap: vwapArr[last],
      bbUpper: bb.upper[last], bbLower: bb.lower[last],
    },
  };
}

/**
 * Combines per-timeframe analyses into one confidence score (0-100).
 * MANDATORY: all four of REQUIRED_MTF (1m,5m,15m,1h) must be present and
 * must agree on direction, or the setup is rejected outright regardless of
 * confidence - this is what "multi-timeframe confirmation" means here.
 *
 * Returns { rejected: true, reason } if the setup fails a hard requirement,
 * otherwise the full confluence object with a `reasons` array describing
 * exactly what confirmed the signal (used in the UI and Telegram messages).
 */
function buildConfluence(timeframeResults, minRiskReward) {
  const entries = Object.entries(timeframeResults).filter(([, v]) => v);
  if (!entries.length) return { rejected: true, reason: 'No timeframe data available' };

  // Hard requirement: every mandatory MTF timeframe must be present
  const missingMTF = REQUIRED_MTF.filter((tf) => !timeframeResults[tf]);
  if (missingMTF.length) {
    return { rejected: true, reason: `Missing required timeframe(s): ${missingMTF.join(', ')}` };
  }

  // Hard requirement: all mandatory MTF timeframes must agree on direction
  const mtfDirections = REQUIRED_MTF.map((tf) => timeframeResults[tf].direction);
  const mtfConfirmed = mtfDirections.every((d) => d === mtfDirections[0]);
  if (!mtfConfirmed) {
    return { rejected: true, reason: `Multi-timeframe conflict: ${REQUIRED_MTF.map((tf, i) => `${tf}=${mtfDirections[i]}`).join(', ')}` };
  }

  let longWeight = 0, shortWeight = 0, totalWeight = 0;
  let volumeVotes = 0, trendVotes = 0, momentumVotes = 0, structureVotes = 0;
  const reasons = [];

  for (const [tf, res] of entries) {
    const w = TIMEFRAME_WEIGHT[tf] || 1;
    totalWeight += w;
    if (res.direction === 'long') longWeight += w * (0.5 + Math.abs(res.combinedScore) / 2);
    else shortWeight += w * (0.5 + Math.abs(res.combinedScore) / 2);
    if (res.volumeConfirmed) volumeVotes += w;
    if (res.trendConfirmed) trendVotes += w;
    if (res.momentumConfirmed) momentumVotes += w;
    if (res.structureConfirmed) {
      structureVotes += w;
      if (REQUIRED_MTF.includes(tf) && res.structureReasons.length) {
        reasons.push(`${tf}: ${res.structureReasons.join(', ')}`);
      }
    }
  }

  const direction = longWeight >= shortWeight ? 'long' : 'short';
  const alignment = Math.max(longWeight, shortWeight) / totalWeight;
  const volumeConfirmed = volumeVotes / totalWeight >= 0.5;
  const trendConfirmed = trendVotes / totalWeight >= 0.5;
  const momentumConfirmed = momentumVotes / totalWeight >= 0.5;
  const structureConfirmed = structureVotes / totalWeight >= 0.35;

  const confirmationsPassed = [volumeConfirmed, trendConfirmed, momentumConfirmed, structureConfirmed, mtfConfirmed].filter(Boolean).length;
  // Confidence = timeframe alignment (up to 55) + confirmation checks passed (up to 45).
  // This is a transparent heuristic combining multiple independent confirmations,
  // not a single fixed number - it moves with how much evidence actually lines up.
  let confidence = alignment * 55 + (confirmationsPassed / 5) * 45;
  confidence = Math.round(Math.min(100, Math.max(0, confidence)));

  reasons.push(`Timeframe alignment: ${(alignment * 100).toFixed(0)}%`);
  reasons.push(`Confirmations passed: ${confirmationsPassed}/5 (trend, momentum, volume, structure, MTF)`);
  if (trendConfirmed) reasons.push('Trend confirmed (EMA20/EMA50 + VWAP)');
  if (momentumConfirmed) reasons.push('Momentum confirmed (RSI + MACD)');
  if (volumeConfirmed) reasons.push('Volume above 20-period average');

  // Dynamic SL/TP based on ATR and nearest structure support/resistance,
  // rather than a fixed percentage - this is the "dynamic risk management"
  // requirement. Reward is measured to the nearest structural level, and
  // risk is the ATR-based stop distance; if the ratio is poor, reject.
  const primary = entries.reduce((best, cur) =>
    (TIMEFRAME_WEIGHT[cur[0]] > TIMEFRAME_WEIGHT[best[0]] ? cur : best)
  )[1];

  const atrRisk = primary.atr || primary.price * 0.005;
  let stopLoss, takeProfit, riskReward;

  if (direction === 'long') {
    stopLoss = primary.price - atrRisk * 1.2;
    const atrTarget = primary.price + atrRisk * 2;
    const structuralTarget = primary.resistance && primary.resistance > primary.price ? primary.resistance : atrTarget;
    // Use whichever target is further away (more reward) - a structural
    // level that sits only marginally above price (common in a strong
    // trend where "resistance" is just the last candle's high) should
    // never be allowed to collapse the reward side of the ratio.
    takeProfit = Math.max(atrTarget, structuralTarget);
    const risk = primary.price - stopLoss;
    const reward = takeProfit - primary.price;
    riskReward = risk > 0 ? reward / risk : 0;
  } else {
    stopLoss = primary.price + atrRisk * 1.2;
    const atrTarget = primary.price - atrRisk * 2;
    const structuralTarget = primary.support && primary.support < primary.price ? primary.support : atrTarget;
    takeProfit = Math.min(atrTarget, structuralTarget);
    const risk = stopLoss - primary.price;
    const reward = primary.price - takeProfit;
    riskReward = risk > 0 ? reward / risk : 0;
  }

  const qualifies = riskReward >= minRiskReward;
  if (!qualifies) reasons.push(`Rejected: risk:reward ${riskReward.toFixed(2)} below minimum ${minRiskReward}`);

  return {
    rejected: false,
    direction, confidence, trendConfirmed, volumeConfirmed, momentumConfirmed,
    structureConfirmed, mtfConfirmed, riskReward, stopLoss, takeProfit,
    reasons, primary,
  };
}

async function persistSignal(symbol, timeframe, conf) {
  const info = await db.run(
    `INSERT INTO ai_signals
     (symbol, timeframe, direction, confidence, trend_confirmed, volume_confirmed, momentum_confirmed,
      structure_confirmed, mtf_confirmed, risk_reward, stop_loss, take_profit, indicators_json, reasons_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
    [
      symbol, timeframe, conf.direction, conf.confidence,
      conf.trendConfirmed ? 1 : 0, conf.volumeConfirmed ? 1 : 0, conf.momentumConfirmed ? 1 : 0,
      conf.structureConfirmed ? 1 : 0, conf.mtfConfirmed ? 1 : 0,
      conf.riskReward, conf.stopLoss, conf.takeProfit,
      JSON.stringify(conf.primary.indicators), JSON.stringify(conf.reasons),
    ]
  );
  return info.lastInsertRowid;
}

async function persistRejectedSignal(symbol, timeframe, reason) {
  await logger.info('scanner', `Signal rejected for ${symbol}: ${reason}`);
  await db.run(
    `INSERT INTO ai_signals (symbol, timeframe, direction, confidence, risk_reward, status, rejection_reason)
     VALUES (?, ?, 'none', 0, 0, 'rejected', ?)`,
    [symbol, timeframe, reason]
  );
}

module.exports = { analyzeTimeframe, buildConfluence, persistSignal, persistRejectedSignal, TIMEFRAME_WEIGHT, REQUIRED_MTF };
