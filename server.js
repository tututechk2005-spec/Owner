'use strict';
require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const WebSocket = require('ws');

const db = require('./src/db');
const logger = require('./src/utils/logger');
const authRoutes = require('./src/auth/authRoutes');
const binanceRoutes = require('./src/binance/binanceRoutes');
const dashboardRoutes = require('./src/routes/dashboard');
const marketsRoutes = require('./src/routes/markets');
const tradingRoutes = require('./src/routes/trading');
const signalsRoutes = require('./src/routes/signals');
const analyticsRoutes = require('./src/routes/analytics');
const historyRoutes = require('./src/routes/history');
const walletRoutes = require('./src/routes/wallet');
const referralRoutes = require('./src/routes/referral');
const settingsRoutes = require('./src/routes/settings');
const notificationsRoutes = require('./src/routes/notifications');
const supportRoutes = require('./src/routes/support');
const profileRoutes = require('./src/routes/profile');
const adminRoutes = require('./src/routes/admin');
const { MarketFeed } = require('./src/binance/wsService');
const AutoTrader = require('./src/ai/autoTrader');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Copy .env.example to .env and set a strong secret.');
  process.exit(1);
}

if (!process.env.ENCRYPTION_KEY) {
  console.error('FATAL: ENCRYPTION_KEY is not set. Copy .env.example to .env and set a strong, stable value.');
  console.error('       This key encrypts Binance API secrets at rest - it must stay IDENTICAL across every');
  console.error('       restart and deployment, or previously-saved API credentials will fail to decrypt.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

// ── Security headers ─────────────────────────────────────────────────────────
// contentSecurityPolicy disabled so CDN scripts (charts etc.) load freely.
// crossOriginResourcePolicy set to cross-origin so fonts/assets load correctly.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.COOKIE_SECRET || 'dev-cookie-secret'));

// ── Static files ─────────────────────────────────────────────────────────────
// MUST come before API routes and rate limiters so assets are never blocked.
// setHeaders explicitly sets correct MIME types to avoid helmet's nosniff rejection.
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.css'))  res.setHeader('Content-Type', 'text/css; charset=utf-8');
    if (filePath.endsWith('.js'))   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Allow browsers to cache static assets for 1 hour, HTML never
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

// ── Rate limiting (API only) ──────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  max: Number(process.env.RATE_LIMIT_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/admin/login', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/binance',       binanceRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/markets',       marketsRoutes);
app.use('/api/trading',       tradingRoutes);
app.use('/api/signals',       signalsRoutes);
app.use('/api/analytics',     analyticsRoutes);
app.use('/api/history',       historyRoutes);
app.use('/api/wallet',        walletRoutes);
app.use('/api/referral',      referralRoutes);
app.use('/api/settings',      settingsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/support',       supportRoutes);
app.use('/api/profile',       profileRoutes);
app.use('/api/admin',         adminRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), uptime: process.uptime() });
});

// 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ── Fallback: serve index.html for any non-API, non-asset route ───────────────
// This handles direct navigation to /dashboard.html etc. when static serve misses.
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── Central error handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcastToClients(payload) {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (_) {}
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
db.ready.then(() => {
  const marketFeed = new MarketFeed(broadcastToClients);
  marketFeed.start('spot_real', ['btcusdt', 'ethusdt', 'bnbusdt', 'solusdt', 'xrpusdt']);
  const autoTrader = new AutoTrader(broadcastToClients);
  autoTrader.start();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ✅ Server:  http://localhost:${PORT}`);
    console.log(`  📁 Static:  ${PUBLIC_DIR}`);
    console.log(`  🔑 Admin:   http://localhost:${PORT}/admin-login.html\n`);
  });
}).catch((err) => {
  console.error('Fatal: DB init failed', err);
  process.exit(1);
});

process.on('uncaughtException',  (err)    => console.error('[uncaughtException]', err.stack || err.message));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

module.exports = { app, server };
