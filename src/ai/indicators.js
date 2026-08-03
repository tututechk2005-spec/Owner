// All functions take arrays of numbers (closes/highs/lows/volumes) in
// chronological order (oldest -> newest) and return arrays of the same
// length (padded with null where there isn't enough data yet), except where
// noted otherwise.

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      const slice = values.slice(0, period);
      prev = slice.reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));
  const validMacd = macdLine.filter((v) => v != null);
  const signalRaw = ema(validMacd, signalPeriod);
  const signalLine = new Array(closes.length).fill(null);
  let offset = macdLine.findIndex((v) => v != null);
  for (let i = 0; i < signalRaw.length; i++) {
    if (signalRaw[i] != null) signalLine[offset + i] = signalRaw[i];
  }
  const histogram = closes.map((_, i) => (macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null));
  return { macdLine, signalLine, histogram };
}

function atr(highs, lows, closes, period = 14) {
  const trs = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { trs.push(highs[i] - lows[i]); continue; }
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  return ema(trs, period);
}

function adx(highs, lows, closes, period = 14) {
  const len = closes.length;
  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);
  const tr = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const smoothTR = ema(tr.slice(1), period);
  const smoothPlusDM = ema(plusDM.slice(1), period);
  const smoothMinusDM = ema(minusDM.slice(1), period);
  const diPlus = smoothTR.map((v, i) => (v ? (smoothPlusDM[i] / v) * 100 : null));
  const diMinus = smoothTR.map((v, i) => (v ? (smoothMinusDM[i] / v) * 100 : null));
  const dx = diPlus.map((p, i) => {
    if (p == null || diMinus[i] == null) return null;
    const sum = p + diMinus[i];
    return sum === 0 ? 0 : (Math.abs(p - diMinus[i]) / sum) * 100;
  });
  const validDx = dx.filter((v) => v != null);
  const adxRaw = ema(validDx, period);
  const out = new Array(len).fill(null);
  const offset = len - 1 - validDx.length + 1;
  for (let i = 0; i < adxRaw.length; i++) out[offset + i] = adxRaw[i];
  return out;
}

function vwap(highs, lows, closes, volumes) {
  const out = new Array(closes.length).fill(null);
  let cumPV = 0, cumVol = 0;
  for (let i = 0; i < closes.length; i++) {
    const typical = (highs[i] + lows[i] + closes[i]) / 3;
    cumPV += typical * volumes[i];
    cumVol += volumes[i];
    out[i] = cumVol ? cumPV / cumVol : null;
  }
  return out;
}

function bollingerBands(closes, period = 20, stdDevMultiplier = 2) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + sd * stdDevMultiplier;
    lower[i] = mean - sd * stdDevMultiplier;
  }
  return { upper, middle, lower };
}

// Simple swing-based support/resistance from recent highs/lows
function supportResistance(highs, lows, lookback = 30) {
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  return {
    resistance: Math.max(...recentHighs),
    support: Math.min(...recentLows),
  };
}

// Very simplified Smart-Money-Concept style structure detection.
// This is a heuristic approximation, not a formal SMC implementation.
function detectStructure(highs, lows, closes) {
  const n = closes.length;
  if (n < 10) return { bos: null, choch: null, liquiditySweep: false, fvg: [], orderBlocks: [] };

  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < n - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      swingHighs.push({ i, price: highs[i] });
    }
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      swingLows.push({ i, price: lows[i] });
    }
  }

  let bos = null; // 'bullish' | 'bearish'
  let choch = null;
  const lastClose = closes[n - 1];
  if (swingHighs.length) {
    const lastSwingHigh = swingHighs[swingHighs.length - 1].price;
    if (lastClose > lastSwingHigh) bos = 'bullish';
  }
  if (swingLows.length) {
    const lastSwingLow = swingLows[swingLows.length - 1].price;
    if (lastClose < lastSwingLow) bos = bos ? bos : 'bearish';
  }
  // CHOCH: a break of structure in the opposite direction of the prior trend
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const priorTrendUp = swingLows[swingLows.length - 1].price > swingLows[swingLows.length - 2].price;
    if (priorTrendUp && bos === 'bearish') choch = 'bearish_choch';
    if (!priorTrendUp && bos === 'bullish') choch = 'bullish_choch';
  }

  // Liquidity sweep: wick beyond a recent swing point followed by close back inside
  let liquiditySweep = false;
  if (swingHighs.length) {
    const lastHigh = swingHighs[swingHighs.length - 1];
    if (highs[n - 1] > lastHigh.price && closes[n - 1] < lastHigh.price) liquiditySweep = true;
  }
  if (swingLows.length) {
    const lastLow = swingLows[swingLows.length - 1];
    if (lows[n - 1] < lastLow.price && closes[n - 1] > lastLow.price) liquiditySweep = true;
  }

  // Fair value gaps: 3-candle imbalance
  const fvg = [];
  for (let i = 2; i < n; i++) {
    if (lows[i] > highs[i - 2]) fvg.push({ i, type: 'bullish', from: highs[i - 2], to: lows[i] });
    if (highs[i] < lows[i - 2]) fvg.push({ i, type: 'bearish', from: lows[i - 2], to: highs[i] });
  }

  // Order blocks: last opposite candle before a strong impulsive move
  const orderBlocks = [];
  for (let i = 3; i < n; i++) {
    const move = closes[i] - closes[i - 1];
    const prevMove = closes[i - 1] - closes[i - 2];
    if (Math.abs(move) > Math.abs(prevMove) * 1.5) {
      orderBlocks.push({ i: i - 1, type: move > 0 ? 'bullish' : 'bearish', high: highs[i - 1], low: lows[i - 1] });
    }
  }

  return { bos, choch, liquiditySweep, fvg: fvg.slice(-5), orderBlocks: orderBlocks.slice(-5) };
}

module.exports = { ema, sma, rsi, macd, atr, adx, vwap, bollingerBands, supportResistance, detectStructure };
