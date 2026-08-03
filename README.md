# Binance AI Trading Platform

A Node.js + Express + SQLite web platform for connecting Binance Spot/Futures
(Testnet or Real) accounts, viewing live account data, trading manually, and
optionally letting a rules-based AI engine auto-trade based on multi-timeframe
technical confluence.

## ⚠️ Read this before connecting a real account

- **Start on Testnet.** `spot_testnet` and `futures_testnet` use Binance's
  sandbox environment with fake funds. Get comfortable there first.
- **The "AI confidence score" is a transparent heuristic, not a proven edge.**
  It blends EMA/RSI/MACD/ATR/ADX/VWAP/Bollinger Band readings and a simplified
  approximation of Smart-Money-Concept structure (BOS/CHOCH/liquidity
  sweeps/fair value gaps/order blocks) across seven timeframes into a 0-100
  score. No combination of classic indicators has been shown to reliably hit
  a 95% real-world win rate — treat the confidence threshold as a
  configurable filter, not a guarantee. Backtest and paper-trade before
  risking real capital, and never risk more than you can afford to lose.
- **This is not financial advice**, and nothing in this codebase should be
  read as investment guidance.
- **Review the security section below** before exposing this to the public
  internet with real API keys attached.

## What's actually implemented

- Express server with a single SQLite database (`database.sqlite`), created
  and migrated automatically on first boot — no external DB required.
- JWT + bcrypt auth for users and a separate admin login, password reset flow,
  rate limiting, Helmet security headers, parameterized SQL everywhere.
- Binance REST client supporting all four modes (`spot_testnet`, `spot_real`,
  `futures_testnet`, `futures_real`) with HMAC-signed requests and detailed
  validation error messages.
- Binance WebSocket integration: a public market-data ticker stream plus
  per-account authenticated user-data streams (listenKey based), both with
  automatic reconnect/backoff.
- API keys are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY` in
  `.env`). Secret keys are **never** sent back to the browser or exposed in
  any API response — only a masked version of the API key is shown.
- A real technical-indicator library (EMA, SMA, RSI, MACD, ATR, ADX, VWAP,
  Bollinger Bands, support/resistance, and a heuristic structure detector)
  written in plain JS with no external TA dependency, verified against
  synthetic data during development.
- A multi-timeframe confluence engine that scores trend/momentum/volume
  agreement into a configurable confidence + risk:reward gate.
- An auto-trading loop that: monitors existing positions before opening new
  ones, prevents duplicate trades on the same symbol/account, applies
  stop-loss/take-profit/trailing-stop/break-even logic, and respects
  per-account risk settings (max risk %, max open positions, leverage).
  The loop is wrapped in try/catch per cycle so one bad tick never kills the
  process, and `ecosystem.config.js` gives PM2 auto-restart on crash.
- Full REST API for dashboard, markets, manual trading, signals, analytics,
  trade history, wallet, referrals, settings, notifications, support
  tickets, profile, and a complete admin panel (users, accounts, trades,
  signals, referrals, deposits/withdrawals, notifications, broadcast,
  support tickets, logs, AI settings, risk settings, site settings,
  maintenance mode, server status).
- A dark, glassmorphism, responsive frontend (vanilla HTML/CSS/JS, no build
  step) covering every page requested: landing, login, register,
  forgot/reset password, dashboard, markets, auto trading, manual trading,
  signals, analytics, trade history, wallet, referral, settings,
  notifications, support, profile, admin login, admin dashboard — with a
  shared sidebar/topbar on desktop and a bottom nav bar on mobile.

## What you should still do before going live with real money

- **Get a professional security review.** This includes reasonable defaults
  (JWT, bcrypt, AES-256-GCM, parameterized queries, rate limiting, Helmet)
  but a platform handling real exchange API keys and executing real trades
  deserves a dedicated audit, especially around key storage, session
  handling, and the admin panel's access controls.
- **Add CSRF protection to state-changing forms** if you expose this outside
  of a trusted single-page session flow (the scaffolding for this is in
  place — `cookie-parser` and cookie-based sessions are wired up — but a full
  CSRF token flow was intentionally kept minimal here to stay within scope).
- **Load-test the AI scanning loop** and tune `AI_SCAN_INTERVAL_MS` /
  `min_confidence` / `min_risk_reward` in the admin panel against Binance's
  rate limits before running many symbols/timeframes continuously.
- **Position sizing in `autoTrader.js` is simplified** (risk % of available
  USDT balance divided by ATR-based stop distance) — review and adapt it to
  your actual exchange rules (minQty, stepSize, minNotional, etc. from
  `exchangeInfo`) before trading Real accounts.
- **Add real email delivery** (SMTP settings are in `.env.example`) — without
  it, password reset links are only logged to the server console /
  returned directly in the API response in dev mode.

## Quick start (local)

```bash
npm install
cp .env.example .env
# Edit .env: set JWT_SECRET, COOKIE_SECRET, ENCRYPTION_KEY to long random
# strings, and change ADMIN_USERNAME / ADMIN_PASSWORD from the defaults.
npm start
```

The server starts on `http://localhost:3000` by default. `database.sqlite`
is created automatically on first run, along with the default admin account.

- App: http://localhost:3000
- Admin login: http://localhost:3000/admin-login.html
- Default admin credentials: `admin` / `admin123` (**change this immediately**
  by editing `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env` before first boot, or
  by changing the password directly in the `admins` table afterward)

## Getting Binance Testnet API keys (recommended first step)

- Spot Testnet: https://testnet.binance.vision
- Futures Testnet: https://testnet.binancefuture.com

Generate a key/secret pair there, then use "Settings" in the app to connect
a `Spot Testnet` or `Futures Testnet` account — no real funds are at risk.

## Environment variables

See `.env.example` for the full list. At minimum, set:

- `JWT_SECRET` — long random string, required for the server to boot
- `COOKIE_SECRET` — long random string
- `ENCRYPTION_KEY` — used to derive the AES-256 key for encrypting API secrets
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — used only on first boot to seed the
  default admin account

No database credentials are needed — SQLite is a local file.

## Running with PM2 (production)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 logs binance-ai-trading-platform
```

PM2 restarts the process automatically on crash (`autorestart: true`,
`max_restarts: 50`), which combined with the in-process reconnect logic in
`wsService.js` and the try/catch-wrapped scan loop in `autoTrader.js` is what
delivers the "restart automatically after crash / reconnect automatically"
requirement.

## Deploying to Railway

1. Push this project to a GitHub repo (or use the Railway CLI directly).
2. Create a new Railway project from the repo.
3. Add the environment variables from `.env.example` in the Railway project
   settings (Railway sets `PORT` automatically — you don't need to set it).
4. Railway will detect `railway.json` / `Procfile` and run `node server.js`.
5. **Important:** Railway's filesystem is ephemeral on redeploys unless you
   attach a persistent volume. Since all data lives in `database.sqlite`,
   mount a Railway volume at the project directory (or a subdirectory you
   point `src/db.js` at) if you need data to survive redeploys.

## Project structure

```
binance-ai-platform/
├── server.js                 # Entry point - wires everything together
├── package.json
├── railway.json
├── Procfile
├── ecosystem.config.js        # PM2 config
├── .env.example
├── database.sqlite            # created automatically on first run
├── src/
│   ├── db.js                  # SQLite schema + seed data
│   ├── auth/                  # JWT auth routes + middleware
│   ├── binance/                # Binance REST client, WS manager, account routes
│   ├── ai/                    # Indicators, signal engine, auto-trading loop
│   ├── routes/                # dashboard/markets/trading/signals/analytics/...
│   └── utils/                 # encryption, logging
└── public/                    # Static frontend (HTML/CSS/vanilla JS)
    ├── css/style.css
    └── js/                    # api.js, auth.js, admin-auth.js, layout.js
```

(Route/service code lives under `src/` and pages under `public/` rather than
a fully flat layout, since a maintainable multi-page app of this size needs
at least that much structure — everything still lives in this single project
root with no separate repos or extra top-level folders.)

## Security notes

- Passwords hashed with bcrypt (cost factor 12).
- Sessions via JWT, `httpOnly` cookies + optional Authorization header.
- Binance API secrets encrypted with AES-256-GCM before being written to
  SQLite; decrypted only in-memory for the duration of a single API/WS call.
- All SQL uses `better-sqlite3` parameterized statements — no string
  concatenation, so standard SQL injection vectors are closed.
- Rate limiting on all `/api/*` routes, with a tighter limit on auth
  endpoints (login/register/admin-login/forgot-password).
- `helmet` sets standard security headers.
- Frontend renders user-supplied text via `textContent`-safe templates where
  practical; review any field before extending it if you plan to accept
  richer HTML input from users.

## License

MIT — use, modify, and deploy as you see fit. No warranty of any kind is
provided, especially regarding trading outcomes.

---

## Update: Scanner, Risk, and Telegram Overhaul

This update makes substantial changes to the scanning and signal engine. Here's exactly what changed and why, including honest tradeoffs:

### 1. Admin account
Unchanged - already correct. On first boot, if no admin exists, one is created from `ADMIN_USERNAME`/`ADMIN_PASSWORD` (defaults `admin`/`admin123`) with a bcrypt hash (cost 12). If an admin already exists, nothing is touched.

### 2. Binance API key validation
Every validation attempt (success or failure) is now logged to the `logs` table. Errors are classified into specific types the frontend can act on: `invalid_api_key`, `invalid_secret`, `missing_permissions`, `clock_skew`, `rate_limited`, `network_timeout`, `network_error`, `binance_server_error`, `database_error`, `unknown_error`. If the Binance key validates successfully but the database write fails afterward, the user gets a distinct message telling them their key *was* valid and only the save failed - this is never conflated with an invalid-key error.

### 3. Dynamic Futures scanner
`fetchFuturesUSDTPerpetuals()` pulls the live exchange info from Binance Futures and filters to `quoteAsset=USDT`, `contractType=PERPETUAL`, `status=TRADING` - suspended/delisted pairs are excluded automatically. The list refreshes on the interval set in AI Settings (default 30 min).

**Important tradeoff, stated plainly:** scanning all 200+ USDT perpetual pairs across 4 timeframes every cycle would be roughly 800+ Binance API calls per tick, which will get you rate-limited or banned. Instead, the scanner round-robins through the full symbol list in configurable batches (`symbols_per_cycle`, default 10) each scan cycle, so every symbol gets scanned regularly without exceeding Binance's limits. Increase `symbols_per_cycle` at your own risk if you have Binance API weight to spare.

### 4. Duplicate protection
- Never opens a second position on a symbol/account that already has one open (unchanged, already correct).
- **New:** a `signal_cooldowns` table tracks the last signal fired per symbol+direction. A new signal in the same direction within `signal_cooldown_ms` (default 15 min) is skipped and logged, not re-fired.
- Telegram messages are marked `telegram_sent` on the signal row so a signal is never announced twice.

### 5. Confidence threshold
Lowered from 95% to **85%** by default (configurable in AI Settings). The confidence score itself was already a computed heuristic (not a fixed value) - it blends timeframe alignment with how many of five independent confirmations passed (trend, momentum, volume, structure, multi-timeframe agreement), and that scoring logic is unchanged, only the default gate was lowered.

### 6. Signal quality / multi-timeframe confirmation
1m, 5m, 15m, and 1h are now **mandatory** - if any is missing or if they disagree on direction, the setup is rejected outright before confidence is even calculated, regardless of what the other configured timeframes say. Structure detection (BOS, CHOCH, liquidity sweep, fair value gap, order blocks) now contributes its own confirmation vote rather than only nudging the trend score.

### 7. Dynamic risk management
Stop-loss and take-profit are computed from ATR and the nearest structural support/resistance level, using whichever target gives the better reward (a naive "last swing high" in a strong trend sits right next to price and used to collapse the reward side of the ratio to near-zero - this is now guarded against). Trades with a resulting risk:reward below the configured minimum are rejected with the exact ratio logged.

### 8. Telegram
New `src/notify/telegram.js` module. Configure via the admin panel (AI Settings tab) or `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` in `.env`. Every signal message includes confidence, risk:reward, entry, stop-loss, take-profit, and the specific reasons that confirmed it. Trade-closed messages are sent separately with the realized PNL. A "Send Test Message" button in the admin panel lets you verify the integration without waiting for a real signal.

### 9. Dashboard additions
User dashboard now shows API connection status, scanner status (scanning/idle), and total pairs tracked. Admin dashboard adds a **Scanner Status** tab (pairs tracked, last scan time, last symbol refresh, last batch scanned, signals executed/rejected today) and a **Rejected Signals** tab showing every rejection with its exact reason.

### 10. Logging
Every rejected signal is persisted with a human-readable reason (missing timeframe, MTF conflict, confidence too low, poor risk:reward, missing confirmation). API validation attempts, scanner cycles, database errors, and Telegram send attempts are all logged through the existing `logs` table and visible in the admin Logs tab.

### 11. Performance / stability
- `AutoTrader.start()` now guards against being called twice (logs a warning and no-ops instead of creating a second loop).
- A `scanInFlight` flag prevents a new scan cycle from starting while the previous one is still running, so a slow cycle can never stack duplicate work.
- An hourly retention job prunes logs older than 7 days and old rejected/stale signals so the SQLite file doesn't grow unbounded on long-running deployments.
- The market-data WebSocket and per-account user-data streams were already single-instance per account type; no changes were needed there.

**What this update does NOT claim:** no combination of technical indicators and structure heuristics can guarantee a real-world win rate, at 85% confidence or any other number. The scoring is transparent and now more heavily gated (mandatory MTF agreement, structure confirmation, dynamic RR rejection), but it remains a rules-based filter, not a proven predictive edge. Test thoroughly on Testnet before connecting a real-money account.
