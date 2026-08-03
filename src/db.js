'use strict';
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite')
  : path.join(__dirname, '..', 'database.sqlite');

// ---------------------------------------------------------------------------
// Open / create the SQLite database file
// ---------------------------------------------------------------------------
const _db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) { console.error('[db] Failed to open database:', err.message); process.exit(1); }
  console.log('[db] SQLite database opened at', DB_PATH);
});

// Enable WAL mode and foreign keys right after open
_db.serialize(() => {
  _db.run('PRAGMA journal_mode = WAL');
  _db.run('PRAGMA foreign_keys = ON');
});

// ---------------------------------------------------------------------------
// Promise-based helpers - run/get/all mirror familiar sqlite patterns
// so every route file works with minimal changes (we just add await).
// ---------------------------------------------------------------------------

/** Run a statement that does not return rows (INSERT/UPDATE/DELETE/CREATE). */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    _db.run(sql, params, function (err) {
      if (err) return reject(err);
      // 'this' is the sqlite3 Statement context
      resolve({ lastInsertRowid: this.lastID, changes: this.changes });
    });
  });
}

/** Return a single row or undefined. */
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    _db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

/** Return all matching rows. */
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    _db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

/** Run multiple statements separated by semicolons (schema creation). */
function exec(sql) {
  return new Promise((resolve, reject) => {
    _db.exec(sql, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Schema – every table the platform needs
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  referral_code TEXT UNIQUE,
  referred_by TEXT,
  role TEXT DEFAULT 'user',
  status TEXT DEFAULT 'active',
  reset_token TEXT,
  reset_token_expires INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS binance_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_type TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,
  api_secret_enc TEXT NOT NULL,
  label TEXT,
  is_active INTEGER DEFAULT 1,
  is_verified INTEGER DEFAULT 0,
  last_verified_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS wallet_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES binance_accounts(id),
  wallet_balance REAL DEFAULT 0,
  available_balance REAL DEFAULT 0,
  margin_balance REAL DEFAULT 0,
  unrealized_pnl REAL DEFAULT 0,
  realized_pnl REAL DEFAULT 0,
  total_profit REAL DEFAULT 0,
  total_loss REAL DEFAULT 0,
  roi REAL DEFAULT 0,
  win_rate REAL DEFAULT 0,
  loss_rate REAL DEFAULT 0,
  total_trades INTEGER DEFAULT 0,
  today_profit REAL DEFAULT 0,
  weekly_profit REAL DEFAULT 0,
  monthly_profit REAL DEFAULT 0,
  current_leverage REAL DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES binance_accounts(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL,
  quantity REAL,
  leverage REAL DEFAULT 1,
  stop_loss REAL,
  take_profit REAL,
  trailing_stop REAL,
  status TEXT DEFAULT 'open',
  pnl REAL DEFAULT 0,
  opened_at INTEGER DEFAULT (strftime('%s','now')),
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES binance_accounts(id),
  binance_order_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  price REAL,
  quantity REAL,
  status TEXT DEFAULT 'open',
  source TEXT DEFAULT 'manual',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS trade_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES binance_accounts(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL,
  exit_price REAL,
  quantity REAL,
  pnl REAL,
  result TEXT,
  source TEXT DEFAULT 'manual',
  closed_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS ai_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence REAL NOT NULL,
  trend_confirmed INTEGER DEFAULT 0,
  volume_confirmed INTEGER DEFAULT 0,
  momentum_confirmed INTEGER DEFAULT 0,
  structure_confirmed INTEGER DEFAULT 0,
  mtf_confirmed INTEGER DEFAULT 0,
  risk_reward REAL,
  stop_loss REAL,
  take_profit REAL,
  indicators_json TEXT,
  reasons_json TEXT,
  rejection_reason TEXT,
  telegram_sent INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- One row per symbol: tracks the last signal fired per direction so the
-- scanner can enforce a cooldown window and never fire duplicate signals.
CREATE TABLE IF NOT EXISTS signal_cooldowns (
  symbol TEXT PRIMARY KEY,
  last_direction TEXT,
  last_signal_at INTEGER,
  last_confidence REAL
);

-- Dynamically-fetched list of tradable Futures USDT-perpetual symbols,
-- refreshed periodically instead of scanning a hardcoded list.
CREATE TABLE IF NOT EXISTS scanner_symbols (
  symbol TEXT PRIMARY KEY,
  status TEXT,
  contract_type TEXT,
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS scanner_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT DEFAULT 'idle',
  total_pairs INTEGER DEFAULT 0,
  last_symbol_refresh INTEGER,
  last_scan_at INTEGER,
  last_scan_batch TEXT,
  cycle_position INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL REFERENCES users(id),
  referred_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT DEFAULT 'active',
  earnings REAL DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  method TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  destination TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'info',
  is_read INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  reply TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  min_confidence REAL DEFAULT 85,
  min_risk_reward REAL DEFAULT 2,
  scan_interval_ms INTEGER DEFAULT 15000,
  enabled INTEGER DEFAULT 1,
  timeframes TEXT DEFAULT '1m,5m,15m,1h',
  symbols TEXT DEFAULT 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT',
  use_dynamic_symbols INTEGER DEFAULT 1,
  symbol_refresh_interval_ms INTEGER DEFAULT 1800000,
  symbols_per_cycle INTEGER DEFAULT 10,
  signal_cooldown_ms INTEGER DEFAULT 900000,
  telegram_enabled INTEGER DEFAULT 0,
  telegram_bot_token TEXT,
  telegram_chat_id TEXT
);

CREATE TABLE IF NOT EXISTS risk_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_risk_per_trade_pct REAL DEFAULT 1,
  max_open_positions INTEGER DEFAULT 3,
  default_leverage REAL DEFAULT 5,
  max_leverage REAL DEFAULT 20,
  stop_loss_pct REAL DEFAULT 1.5,
  take_profit_pct REAL DEFAULT 3,
  trailing_stop_pct REAL DEFAULT 1,
  break_even_trigger_pct REAL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT DEFAULT 'info',
  scope TEXT,
  message TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS ai_learning_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT,
  timeframe TEXT,
  signal_id INTEGER,
  outcome TEXT,
  pnl REAL,
  features_json TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  user_agent TEXT,
  ip TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  expires_at INTEGER
);
`;

// ---------------------------------------------------------------------------
// Initialise schema + seed defaults, then export a ready promise
// ---------------------------------------------------------------------------
async function initDb() {
  await exec(SCHEMA);

  // Default admin
  const adminCount = await get('SELECT COUNT(*) as c FROM admins');
  if (!adminCount || adminCount.c === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(password, 12);
    await run('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [username, hash]);
    console.log('[db] Default admin created -> username:', username);
  }

  // AI settings row
  const aiRow = await get('SELECT id FROM ai_settings WHERE id = 1');
  if (!aiRow) {
    await run('INSERT INTO ai_settings (id, min_confidence) VALUES (1, ?)', [
      Number(process.env.AI_MIN_CONFIDENCE || 85),
    ]);
  }

  // Risk settings row
  const riskRow = await get('SELECT id FROM risk_settings WHERE id = 1');
  if (!riskRow) {
    await run('INSERT INTO risk_settings (id) VALUES (1)');
  }

  // Scanner state row
  const scannerRow = await get('SELECT id FROM scanner_state WHERE id = 1');
  if (!scannerRow) {
    await run('INSERT INTO scanner_state (id, status) VALUES (1, ?)', ['idle']);
  }

  // Site settings
  const siteDefaults = {
    site_name: 'Binance AI Trading Platform',
    maintenance_mode: 'off',
    registration_open: 'on',
  };
  for (const [k, v] of Object.entries(siteDefaults)) {
    await run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, v]);
  }

  console.log('[db] Schema ready.');
}

// Export the promise so server.js can await it before starting
const ready = initDb().catch((err) => {
  console.error('[db] Initialisation failed:', err);
  process.exit(1);
});

module.exports = { run, get, all, exec, ready };
