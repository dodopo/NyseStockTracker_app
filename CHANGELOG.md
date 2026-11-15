# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/)  
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
-

### Changed
-

### Fixed
-


## [0.10.0] - 2026-11-15

Chart: cleaner labels, longer and custom periods, and crypto search without a key. No database migration.

### Added
- **Periods 3A, 5A and 10A** (weekly candles by default; daily or monthly on request).
- **Custom period** (calendar icon next to the period buttons): "De" and "Até" dates, validated on the server (from 01/01/1990, not in the future, start before end). The candle size follows the length of the period; minute candles only for short periods. When the period starts before the available history, the chart says "Dados disponíveis a partir de DD/MM/AAAA".
- **Crypto search without a key**: Coinbase's list of US dollar pairs with names (public, cached 24 h), with known aliases (ETH = "Ethereum"). The Massive key is now only a fallback. Crypto no longer needs any Massive key.
- Tests: 99 (search, delisted coins, the new periods, date validation, cache per custom dates, averages in periods that end in the past).

### Changed
- **Line names no longer cover the candles.** "MM200D", "MM200S", "MM50M", "Agora" and "Meu PM" moved from inside the chart to the legend above it, each in its color with its value; the price axis keeps only the colored value boxes (like TradingView), also in full screen.

### Fixed
- In a period that ends in the past, the last candle showed today's moving-average values. Averages are now bounded to the end of the last candle.
- In a period that ends in the past, the "Agora" line no longer stretches the price scale.

## [0.9.1] - 2026-11-15

Chart cache fix found with real data. No database migration.

### Fixed
- **A newly saved key now takes effect immediately.** The chart cache was keyed only by asset, period and candle size, so a chart loaded through Massive before the Alpaca key was saved kept being served for up to 6 hours (seen on 15/11: AAPL showed "Dados: Massive" and "histórico insuficiente" for the 200-week and 50-month averages until the service was restarted). The cache key now includes the providers available to the user.
- **No chart without a key, not even a cached one.** The key check now runs before the cache lookup, so a user without keys never receives candles cached for another user.

### Added
- **Fallbacks are visible.** When the main provider fails and another one answers, the chart footer says so (e.g. "Alpaca indisponível agora, usando a reserva"), the server logs the failure (status and short reason, never URLs or keys), and the fallback answer is cached for only 5 minutes so the main provider is tried again soon. A crypto coin that Coinbase simply does not list (404) still goes to Binance without a warning.
- Tests: 96 (4 new for the cache key, the key check order, fallback notice and retry, and unlisted coins).

## [0.9.0] - 2026-11-14

Better chart data and long-term moving averages. Database migration v6 is **additive** (two new columns in `users`); rolling back to v0.8.0 works on the same database.

### Added
- **Crypto charts in real time, no key needed**: Coinbase public market data (Binance as fallback, Massive as last resort). Bitcoin history since July 2015.
- **US stock charts from Alpaca** (free plan): all US exchanges with 15 min delay, split-adjusted like TradingView, history since 2016. Settings → Conta → **Chave da Alpaca** (API Key ID + Secret Key, tested before saving, shown masked, never exported in backups). Massive stays as fallback.
- **"Máx" = all history available** (it was capped at the 2 years of Massive's free plan).
- **Moving averages with on/off buttons**: 200 days, 200 weeks and 50 months, each with its own color, value in the legend and label on the price axis. They use only data known on each day (no look-ahead) and work on any candle size; "histórico insuficiente" is shown when there is not enough history. The choice is remembered in the browser.
- **"Agora" line**: the live quote drawn on the chart, so a delayed chart is obvious.
- **Data source under the chart** (Alpaca, Coinbase, Binance or Massive, with its delay) and an amber **"Dados até DD/MM HH:MM"** notice when the last candle is older than the source promises.
- `GET /api/indicators`, `POST /api/auth/alpaca-key`; `ALPACA_DATA_URL`, `COINBASE_BASE_URL`, `BINANCE_BASE_URL` (advanced/testing).
- `server/providers/`: one module per data provider with the same shape; weekly, monthly and 30 min candles are built from smaller ones when the provider does not offer them.
- Tests: 92 (14 new for providers, fallbacks, the Alpaca free-plan rules, moving averages, the Alpaca key, the stale notice and migration v6). Tests never reach the network.

### Changed
- Crypto statistics (52 weeks, average volume) no longer need the Massive key.
- On intraday charts the price scale follows the candles; long moving averages far from today's prices do not squash the chart.

### Fixed
- Crypto charts showed the previous day as if it were the last 24 hours (Massive's free plan delivers crypto only up to the end of the previous day, UTC). Found with real data on 14/11: last candle $68,324 while the market was at about $64,000.

### Notes
- Why these providers: tested on 14/11 with a real key from Brazil. Alpaca's free plan gave daily bars since 4 Jan 2016, split adjustment (NVDA 1,209.98 → 121) and 200 requests per minute. Coinbase and Binance public candles returned the current minute without a key.
- Crypto search still uses the Massive key.

## [0.8.0] - 2026-11-14

Multi-asset: your own tabs and a crypto asset type. Database migration v5 is **additive** (a new `tabs` table and two new columns in `stocks`); existing assets go to a default tab "Ações" automatically.

### Added
- **Tabs you define**: Settings → Abas to create, rename, recolor, reorder and delete tabs. Each tab holds one asset type; you can have several tabs of the same type (e.g. "Cripto" and "Longo prazo"). The **"+"** in the tab bar opens this screen. A tab with assets can only be deleted after choosing another tab of the same type to receive them (trades are kept); the last tab cannot be deleted.
- **Crypto asset type**: search by name or symbol (Massive reference data, US dollar pairs only), live price from Finnhub (Binance USDT pair) with Massive's previous close as fallback, quantities with up to 8 decimals, chart and statistics from Massive daily history. Crypto charts have no market session: 1D shows the last 24 hours and the "Estendido" toggle is only shown for stocks.
- **Consolidated view grouped by tab**, with a subtotal (value and P/L) per tab. Clicking a row opens the asset in its tab.
- Addresses per tab: `#/aba/3/X%3ABTCUSD`. Old links (`#/acoes/AAPL`) still work and open the asset in its tab.
- `GET/POST /api/tabs`, `PATCH /api/tabs/:id`, `POST /api/tabs/reorder`, `DELETE /api/tabs/:id?moveTo=`; `POST /api/stocks` now requires `tabId` (the asset type must match the tab); `GET /api/search?type=crypto`.
- Backups include the tabs; older backups (without tabs) still restore, into default tabs.
- `shared/assetTypes.ts`: asset types are defined in code (labels, search, quote and chart rules), tabs are data. Adding a new type later does not change the tabs.
- Tests: 78 (13 new for tabs, crypto, migration v5 and backups).

### Changed
- Crypto assets are stored in the Massive format (`X:BTCUSD`) and shown as `BTC`.
- On phones the tab bar scrolls sideways and keeps the open tab in view.

### Notes
- **Rollback to v0.7.x**: the code runs on the migrated database, but v0.7.x does not accept crypto tickers and its price lookup fails for the whole portfolio while a crypto asset exists. Before rolling back, delete the crypto assets or restore the backup made before the update.
- Crypto search, charts and statistics need the Massive key (Settings → Conta → "Chave dos gráficos"); without it, the crypto search shows a link to Settings.


## [0.7.1] - 2026-11-14

Chart fixes found while validating v0.7.0 with real Massive data. No database migration.

### Fixed
- **Trade markers no longer overlap.** Labels collided when trades were close in time (e.g. buys on Mar 18 and Mar 31 on a daily chart). Markers are now arrows only, one per candle and side (trades on the same candle are grouped), and the trades of the candle under the mouse are listed below the legend, e.g. "▼ Venda 500 @ $301,64 · 21/04/2026".
- **Intraday shows the regular session by default.** Massive intraday bars include pre- and after-market (04:00–20:00 New York), so the last 1D candle could differ from the official close. Intraday charts now show 09:30–16:00 New York (handles daylight saving) with an **"Estendido"** toggle for extended hours.

### Added
- `shared/chartData.ts` (pure chart helpers) and 7 tests (65 in total).


## [0.7.0] - 2026-11-14

Charts: TradingView-style price chart for every asset. Database migration v4 is **additive** (one new column); rolling back to v0.6.x works on the same database.

### Added
- **Price chart** in the Ações tab (TradingView Lightweight Charts™ 5.3, Apache-2.0): candlesticks + volume, periods 1D · 1S · 1M · 3M · YTD · 1A · Máx with an automatic candle size (like TradingView) or a chosen one (5 min to 1 month), crosshair legend with Open/High/Low/Close, change and volume (with time on intraday candles), change over the selected period, local-time axis, and full screen (Esc to exit).
- **Your trades on the chart**: ▲ buys and ▼ sells as markers, and a dashed **"Meu PM"** line at your average price.
- **Statistics card**: 52-week low/high with a position bar, average volume (10 days / 3 months), market cap and beta (Finnhub).
- **Massive (ex-Polygon) key** per user for historical candles: Settings → Conta → "Chave dos gráficos", tested before saving, shown masked, never exported in backups.
- `GET /api/candles`, `GET /api/stats`, `POST /api/auth/massive-key`; `MASSIVE_BASE_URL` (advanced/testing).
- Tests: 58 (12 new for candles, pacing, key handling and the new routes).

### Changed
- The delete-account button explains why it is locked until the password and e-mail are filled in.
- Chart code is lazy-loaded (separate ~188 kB chunk), so the first page load stays about the same size.

### Notes
- Why Massive: the free Finnhub plan returns "You don't have access" for candles (tested with a real key), and the free Twelve Data plan is licensed for "internal non-display usage" only. The free Massive plan is licensed for personal, non-professional use, with 2 years of history and 5 requests per minute; the server caches and paces calls so the chart never hits that limit. Data is delayed.


## [0.6.0] - 2026-11-14

Account settings: the "Conta" area in Settings is now fully working. No database migration.

### Added
- **Change password**: requires the current password; signs out every other device (keeps the current session).
- **Change e-mail**: requires the current password; the new e-mail must be valid and not in use.
- **Change Finnhub key**: shows the current key masked (last 4 characters) and **tests the new key with Finnhub before saving**, so a mistyped key never replaces a working one.
- **Sign out of all devices** (ends every session, including the current one).
- **Account info**: e-mail, name, created at, last login, masked Finnhub key, active sessions and app version.
- `GET /api/account`, `POST /api/account/password`, `POST /api/account/email`, `POST /api/account/logout-all`.
- Tests: 46 (8 new for the account flows).

### Changed
- Saving a Finnhub key (onboarding or settings) now verifies it with one real quote request first; rejected keys return a clear message.
- Restoring a backup created with another e-mail (for example before an e-mail change) now asks for the current password instead of refusing outright. Backups of other people still require the account owner's password.


## [0.5.0] - 2026-11-14

Foundation release: modular code, exact decimals (ready for crypto), safer operations.
Database migration v3 is **additive**: rolling back to v0.4.x keeps working on the same database
without restoring a backup. Upgrading a v0.4.x server: see "Primeira atualização vindo da v0.4.x"
in `docs/SELF_HOSTING.md` (installs the update command and applies `Umask 077`).

### Added
- Clickable rows in the consolidated table (mouse and Enter) open the asset in the Ações tab.
- URL routes per screen (`#/consolidado`, `#/acoes/AAPL`): browser back button and bookmarks work.
- Show/hide toggle on every password field, placed beside the input so it never covers password-manager icons.
- Delete your own account (Settings → danger zone): requires the password and the e-mail typed again; deletes the whole portfolio.
- `scripts/update.sh` (`nysetracker-update vX.Y.Z`): backup, install, build and tests before touching the service, restart, health check, automatic rollback on any failure; refuses tags that were altered upstream.
- `GET /api/health` with the running version.
- GitHub Actions CI: lint, tests, build and `npm audit` on Node 22, 24 and 26 (read-only permissions, actions pinned to commit SHAs).
- `allowScripts` in `package.json`: only reviewed packages (pinned versions) may run install scripts.
- Tests: 38 (exact decimals, average-price calculation, shared schemas, migration v3, rollback compatibility, delete account, health).

### Changed
- Exact decimals: quantities and prices are stored and transported as decimal strings with up to 8 places (1 satoshi), and the average price / P&L are computed with `big.js`. No more floating-point drift (0.1 + 0.2 − 0.3 = 0).
- `src/App.tsx` (1,773 lines) split into `features/`, `hooks/`, `api/` and `components/`. Screens are no longer defined inside `App`, which remounted them (and lost typed input) on every render.
- Validation rules live in `shared/` and run identically in the browser (early feedback) and on the server (authoritative), with zod.
- Single API client: every call checks the HTTP status and shows the server's message.
- TypeScript `strict` mode on; the React type definitions were missing and are now installed.
- Fonts are self-hosted (latin subsets); the browser no longer contacts Google on each visit, and the CSP no longer allows Google domains.
- LaunchDaemon templates use `Umask 077`: database, backups and logs are created owner-only.

### Fixed
- Error message wording for invalid quantities/prices.


## [0.4.1] - 2026-11-14

### Fixed
- Install failed on Node.js 26: `better-sqlite3` 12.x does not compile against the Node 26 V8 API. Upgraded to `better-sqlite3` 13.2, which uses N-API, so the native module no longer breaks on new Node.js major versions. Verified on Node 25 (dev) and Node 26 (server).


## [0.4.0] - 2026-11-14

Self-hosting kit: run the app 24/7 on a personal Mac, private and without paid cloud.

### Added
- `docs/SELF_HOSTING.md`: step-by-step guide for macOS (dedicated non-admin service user, LaunchDaemons, private HTTPS via `tailscale serve`, closing sign-ups, update, rollback, restore and uninstall).
- `deploy/macos/` LaunchDaemon templates for the app (start at boot, restart on failure) and a daily backup at 03:45.
- `npm run backup`: online SQLite backup (safe while the app runs), integrity check, owner-only permissions and retention (`BACKUP_DIR`, `BACKUP_RETAIN`).
- Backup tests (24 tests in total).
- `engines.node >= 22` in `package.json`.

### Fixed
- Backup files are self-contained (journal mode switched to DELETE), so no `-wal`/`-shm` leftovers accumulate in the backup folder.


## [0.3.0] - 2026-11-14

Security hardening release, based on an AppSec audit of v0.2.0.
Rollback point: tag `railway-final` (commit `7c94ae2`, last version deployed on Railway).

### ⚠️ Breaking
- Password is now **mandatory** (minimum 12 characters). Accounts created without a password in v0.2.0 can no longer log in; create a new account.
- The server-wide `FINNHUB_KEY` fallback was removed. Each user saves their own key in the onboarding screen.
- The server now listens on `127.0.0.1` by default. Set `HOST=0.0.0.0` to expose it on the network.
- All existing sessions are invalidated by the database migration (users simply log in again).
- `npm start` now runs the production server (`NODE_ENV=production tsx server.ts`); run `npm run build` first.

### Security
- Fixed critical issue: accounts without a password could be accessed with the e-mail only.
- Sessions now expire (`SESSION_TTL_DAYS`, default 7), use 256-bit random tokens and only a SHA-256 hash of the token is stored in the database.
- Rate limiting on login/register (`AUTH_RATE_LIMIT` per 15 min) and on the whole API (`API_RATE_LIMIT` per minute).
- Login always runs bcrypt (cost 12), even for unknown e-mails, to avoid account enumeration by timing.
- Security headers via Helmet, including a Content Security Policy in production; `X-Powered-By` removed.
- Internal errors return a generic message; details go only to the server log. Finnhub URLs (which carry the token) are never logged or returned.
- `/api/prices` accepts at most 50 symbols; symbols, tickers, dates, amounts and text fields are validated server-side.
- Quote cache is bounded in size (no unbounded memory growth).
- Backups no longer include the Finnhub key by default; restoring a backup without a key keeps the current key.
- JSON body limit is 100 kB, except for backup import (5 MB, with item count limits).
- Dependencies updated: 0 known vulnerabilities (`npm audit`), down from 22.

### Added
- `ALLOW_REGISTRATION` to close sign-ups after creating your own account.
- `DATA_DIR` to keep the SQLite database outside the code folder.
- `TRUST_PROXY`, `COOKIE_SECURE`, `SESSION_TTL_DAYS`, `AUTH_RATE_LIMIT`, `API_RATE_LIMIT` settings (see `.env.example`).
- Automated security test suite (`npm test`, Vitest + Supertest, 21 tests).
- Business rules enforced on the server: a SELL cannot exceed the position held on that date, deleting a BUY that would make a position negative is refused (409), and a restore with a negative position is rolled back.

### Changed
- Backend split into `server/config.ts`, `server/db.ts`, `server/validation.ts` and `server/app.ts` (`createApp`), with `server.ts` as a thin entry point.
- Database migrations are versioned with `PRAGMA user_version` and never drop tables with user data. A database older than v0.2.0 now fails closed instead of being wiped.
- Vite is loaded only in development.

### Removed
- Unused `@google/genai` dependency and `src/services/geminiService.ts` (dead code calling non-existent routes).
- Unused `uuid` dependency (replaced by Node's `crypto`).


## [0.2.0] - 2026-03-08

### Added
- Local user authentication system
- User-level data isolation
- Finnhub API onboarding flow
- Settings modal with backup and restore tools
- JSON backup export
- Full portfolio restore from backup
- Smart backup filenames including user and timestamp
- Deterministic transaction ordering using `sort_order`

### Changed
- Refactored `/api/quote` to reuse cached Finnhub responses when available
- Refactored `/api/prices` to reuse the same internal cached quote logic
- Improved consolidated portfolio dashboard
- Moved backup and restore actions into Settings
- Improved transaction history ordering
- Improved restore pipeline behavior

### Security
- Backup restore restricted to the same logged-in user
- Backup ownership validated before restore
- Protection against cross-user data import

### Fixed
- Stable PM calculation for multiple same-day transactions
- Consistent realized and unrealized P/L after restore
- Correct handling of same-day transaction sequences


## [0.1.1] - 2026-03-01
### Fixed
- Correct P/L toggle behavior (Unificado vs Separado) in Consolidated view

### Changed
- Updated README (technologies and execution instructions)
    - Corrected tech stack description (removed Vite as runtime assumption)
    - Clarified how to run the development server 


## [0.1.0] - 2026-03-01
### Added
- Initial tracked version of the app in this repository, as currently working on `main`
- Core tracking UI and initial features already implemented up to this point

### Notes
- This is the baseline version we will tag later as the first stable release
