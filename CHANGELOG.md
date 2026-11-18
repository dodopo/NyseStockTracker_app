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


## [0.15.0] - 2026-11-18

**Tranches e maturação.** Each purchase is a tranche with its own target date (purchase date + target days); sales take from the oldest tranches, or from the ones you choose; the ladder shows how many days each tranche has left and the horizon those days fall in today. **Database migration v9 (adds only): back up first.** The average price and cost do not change. Going back to v0.14.x means restoring the backup (v0.14 does not know chosen tranches); `dodopoam-update` does it by itself on failure.

### Added
- **Target days of the thesis** (per asset): the "Prazo" range now comes with a number of days, starting at the range's upper bound (Curtíssimo 30, Curto 180, Médio 720, Longo 1,800; Longuíssimo starts at 3,650) and editable; the range always follows the days.
- **Tranches.** Each BUY inherits the asset's target, or gets its own ("Prazo-alvo desta tranche"), also editable later in the ladder. Target date = purchase date + target days.
- **Sales and tranches.** By default a sale takes from the oldest tranches; "Escolher tranches" in the sale form lets you say how much comes from each. Impossible choices are refused (more than a tranche has at that date, another asset's or portfolio's purchase, a total that does not match), and so is a later change that would break a choice already made (a back-dated automatic sale eating a chosen tranche, deleting a purchase a sale chose).
- **Escada de maturação** (asset detail): one line per open tranche with purchase date, open quantity, price, target days, maturity date, days left, the horizon it is in today ("Maturada" highlighted), today's value and the result against that purchase's price.
- **Consolidated "Por prazo"** with a switch: **Tese** (each asset in its thesis range, as before) or **Maturação** (each tranche's value in the range of the days it has left; one asset may span several ranges).
- History shows which tranches each sale took and each purchase's own target.
- API: `classification` accepts `targetDays`; trades accept `targetDays` (BUY) and `lots` (SELL, `[{buyId, shares}]`) and return `target_days` and `lots`; `PATCH /api/transactions/:id/target`.

### Changed
- Backups carry targets and chosen tranches (purchase ids are remapped on restore; a choice that does not fit falls back to oldest first and is counted as skipped).

### Security
- The database itself refuses a tranche choice across assets or portfolios, or from a sale to a sale (trigger), refuses changing the date, quantity, asset or type of a trade that is part of a choice (trigger), and refuses deleting a chosen purchase (foreign key); deleting a whole asset, portfolio or account still works.
- An invalid tranche choice is refused before asking the Banco Central.
- Independent review before release: no high-severity finding; 1 medium (an asset with inconsistent history left by an older version blocked unrelated trades: now only a change that creates a new problem is refused) and 3 low ones fixed, each with a test that fails without the fix. The sale form lists the tranches open on the sale date.


## [0.14.0] - 2026-11-17

**Classificações e multimoeda.** Each asset gets liquidity, horizon and jurisdiction; each trade records the currency paid and the Banco Central PTAX of its date, so cost and results can be shown in BRL, USD, EUR or CHF at the historical rate. **Database migration v8 (adds columns only): back up first.** An older version still runs on the migrated database, but going back is safest by restoring the backup, which `dodopoam-update` does by itself on failure.

### Added
- **PTAX frozen on each trade.** Saving a trade fetches the Banco Central closing bulletin (buy and sell, USD, EUR and CHF in reais) of its date from the BCB open data API (no key; only dates and currency codes are sent). Weekends and holidays use the last business day before (shown on the trade). A trade of today before the bulletin (~13h) gets the previous day's rate marked **provisional**, replaced automatically; trades without PTAX (BCB down, restored backups, older versions) are filled in every 30 minutes. Final rates are cached per date.
- **Currency paid** on each trade: BRL, USD, EUR or CHF (default: the asset's currency). A trade paid in another currency enters the average price at its own PTAX; while its PTAX is not known it uses today's rate (flagged as approximate) and, with no rate at all, it is left out of the position (flagged), never counted in the wrong currency.
- Old dates: a currency the BCB did not quote then (the euro before 1999) is left out of that trade's PTAX (conversions to it use today's rate); a date with no PTAX at all is not asked again. Future dates wait for their day.
- **Consolidated and Visão Global in USD, BRL, EUR or CHF.** Cost, average price and realized result use the PTAX (sell) of each trade's date; only the current price uses today's rate (Coinbase, 10 min cache). The P/L in another currency therefore includes the exchange-rate variation. A note says how many trades still have no PTAX (converted at today's rate meanwhile).
- **Classification of each asset** (per portfolio): liquidity (Líquido/Ilíquido), horizon in calendar days (Curtíssimo up to 30, Curto 31-180, Médio 181-720, Longo 721-1,800, Longuíssimo above 1,800) and jurisdiction (Onshore/Offshore), "Não definido" where it applies. US stocks start Offshore; crypto starts "Não definido". "Aplicar a todos os ativos da aba" copies one asset's classification to the whole tab (asks first).
- **Allocation** by liquidity, horizon, jurisdiction and currency (exposure; crypto shown apart), besides portfolio, tab and asset.
- Each trade in the history shows its PTAX (US$ 1 = R$ x, with EUR and CHF on hover) or "PTAX pendente".
- API: `PATCH /api/stocks/:ticker/classification`, `POST /api/tabs/:id/classification`, `GET /api/fx` (reais per USD, EUR, CHF). Trades accept `currency` and return `fx`.

### Changed
- `GET /api/fx` (reais per USD, EUR, CHF) replaces `GET /api/fx/usdbrl`, which stays for pages opened before the update.
- A SELL larger than the position is refused before asking the Banco Central.
- Backups carry classification, currency and PTAX; backups from older versions get the defaults (and the PTAX is fetched again).
- "Aplicar a todos os ativos da aba" is covered by the confirmation guard (`tests/confirm.test.ts`).

### Security
- New routes are scoped to the logged-in user and the portfolio in `X-Portfolio-Id` (another portfolio's tab or asset is 404). Allowed values are checked by the server (zod, unknown fields refused) and by the database (CHECK constraints).
- Restoring a backup keeps a trade's PTAX only if it is coherent (rates within a sane range, bulletin on or up to 15 days before the trade); otherwise it is fetched again from the BCB.
- Independent review before release: 1 high and 5 low/medium findings, all fixed, each with a test that fails without the fix.


## [0.13.1] - 2026-11-17

**Nothing is deleted without asking.** No database change; updating is enough (no restore needed to go back to v0.13.0).

### Fixed
- Deleting a trade in "Histórico de Transações" happened on the first click, with no confirmation. It now asks first, showing the trade (type, asset, date, quantity and price).

### Changed
- Every deletion goes through one confirmation (`src/lib/confirm.ts`) that ends with "Isso não pode ser desfeito.": trade, asset (now says how many trades go with it), tab, restore and account. The delete functions in `usePortfolio` require the question, so a new delete button cannot skip it.
- Restore and account deletion warnings now say they affect **every** portfolio (they still said "a carteira", from before v0.13.0).
- Deleting a portfolio keeps its own stronger check (password + typed name).

### Security
- New test (`tests/confirm.test.ts`): every call in the app to an endpoint that deletes or replaces data must ask first, or CI fails. Checked by removing the trade confirmation: the test fails pointing at that line.


## [0.13.0] - 2026-11-17

**Carteiras: one login, many portfolios.** Each portfolio (company, individual, offshore...) has its own tabs, assets and trades, and the same asset can be in more than one. **Database migration (structural): back up first; going back to v0.12.x requires restoring the backup.**

> **Self-hosted:** reinstall `dodopoam-update` from the v0.13.0 tag **before** updating (command in `docs/SELF_HOSTING.md`, "Atualizar para uma nova versão"), so that a failed update also puts the database back.

### Added
- **Portfolio switcher** (Gmail style) in the header: avatar with the active portfolio's color and initials; menu with every active portfolio and its value, **Visão Global**, "Nova carteira" and "Gerenciar carteiras". The active portfolio is remembered per device.
- **Gerenciar carteiras**: rename, color, reorder, archive/unarchive (nothing is deleted; archived portfolios leave the switcher and the global view) and delete (asks for the password and the typed name; removes that portfolio's tabs, assets and trades). The only active portfolio cannot be archived or deleted.
- **Visão Global**: every active portfolio summed. Filter chips by portfolio, table grouped by portfolio (tab shown under each asset), allocation "Por carteira", "Por aba" or "Por ativo" (the same asset in two portfolios counts once), USD | BRL. Clicking an asset opens it in its portfolio.
- API: `GET/POST /api/portfolios`, `PATCH /api/portfolios/:id`, `POST /api/portfolios/reorder`, `POST /api/portfolios/:id/delete`, `GET /api/global`. Asset, tab and trade routes act on the portfolio in the `X-Portfolio-Id` header (default: the first active one), always checked against the logged-in user (anything else is 404).
- `dodopoam-update` takes a second backup right before restarting and, if the new version does not come up, stops the service, reinstalls the previous code and restores that backup. The database path comes from the app's own config (`npm run db-path`); the copy is made and checked before anything is moved; the failed database is kept as `portfolio.db.falhou-<time>`; start is retried; if the database cannot be restored and may have been migrated, the service is left stopped on purpose with instructions (never the old code on a migrated database, never a missing database file).
- `dodopoam-update` refuses to run when it is not the updater published with the requested version (reinstall it first).
- Tests: 156 (audit gate; migration from a real v6 database row by row, ids and counters kept, failed check leaves the database untouched; portfolios: scope, anti-IDOR on every route, same ticker in two portfolios, archive, delete, global view, names; backup format 2 including refusals; updater: success, rollback with database restore, disk full, service that does not start, updater mismatch). Key safeguards checked by mutation. Migration rehearsed on a copy of the production database: every row identical, id counters kept, second start changes nothing.

### Security
- **Dependency gate in CI** (`scripts/audit-check.mjs`): fails on any moderate+ advisory except entries in `.audit-allowlist.json`, each with a reason and an expiry date (an expired entry fails by itself). Current exception, approved 17/11/2026, until 2026-12-17: GHSA-fc5q-39xc-vjpf (picomatch ReDoS, no fixed version yet; used only by the build/test tools vite and vitest with the project's own patterns, never with user input or in app requests).
- Independent review applied before release: every scoped request names its portfolio explicitly and late responses are dropped after a switch (no action can hit another portfolio); a restore whose portfolios do not map completely is refused without changing anything; portfolio names compared the same way everywhere (Unicode, case-insensitive); account-wide caps on assets and trades match what a backup can restore; a device whose portfolio was deleted elsewhere switches to a valid one.

### Changed
- **Database v7**: new `portfolios` table; `tabs`, `stocks` and `transactions` rebuilt with `portfolio_id` (one transaction, every row and column verified before the old tables are dropped, foreign keys checked, ids and id counters kept). Every user gets "Carteira principal" with everything they had.
- **Backup format 2**: the whole account with every portfolio (archived ones too). Restoring still replaces the whole account. Older backups still import, into "Carteira principal".
- Settings → Abas edits the tabs of the active portfolio (hidden in the global view).
- Narrower header on phones (fits 375 px with the switcher).
- Server code: HTTP helpers in `server/http.ts`, portfolio routes in `server/portfolios.ts`; color picker shared by tabs and portfolios.


## [0.12.0] - 2026-11-17

**New name: Dodopo Asset Manager** (was NYSE Stock Portfolio Tracker / NyseStockTracker_app). The app is no longer only about NYSE stocks; it is becoming a multi-asset portfolio manager. No database migration.

> **Self-hosted installs (user `nysetracker`):** this version also renames the server side (user `dodopoam`, services `local.dodopoam.*`, command `dodopoam-update`). Do **not** use `nysetracker-update v0.12.0`; follow "Migrar de uma instalação antiga" in `docs/SELF_HOSTING.md` (one-time script with dry run and automatic rollback; the old install is kept intact).

### Docs
- The migration script is written straight to a root-only path (no `/tmp`), checked against the SHA-256 published in the Release notes, and run with `sudo sh`.

### Added
- iPhone home screen: "Dodopo AM" as the short name under the icon, app icon (`apple-touch-icon`), favicon and web manifest (opens in the browser as before).
- `scripts/migrate-from-nysetracker.sh`: one-time server migration to the new names. Read-only `--dry-run`; installs and tests the new version with the old app still up; backs up, stops the old app, copies data byte for byte (checked with `cmp` and SQLite `integrity_check`); parks the old services and command so they do not return on reboot; starts the new services on the same port and waits for the new version. Any failure after the old app stops, an unexpected exit or Ctrl+C puts the old install back automatically (and only reports success when the old version answers again); a dropped SSH session does not stop it, and everything is logged to `/usr/local/share/dodopoam-migration/migrate.log`; `--rollback` does it on demand. Refuses an unexpected `DATA_DIR`, a tag whose `package.json` version differs, or a service template that would not run as the new user. Root never writes through files the new user controls (data folder stays root-owned until copied; templates and updater are read from the tag with `git show`). A retry after a rollback keeps the earlier attempt's data aside instead of deleting it. Nothing of the old install is deleted. Reviewed adversarially before release.
- Tests: 128 (migration end to end on a fake machine: dry run, success, refusing a second run, rollback on demand, unhealthy new version, corrupt copy, service that does not start, failing tests, preflight refusals, wrong `DATA_DIR`, version mismatch, tampered template, retry after rollback, Ctrl+C, dropped connection, new service that will not stop).

### Changed
- Name in the screens (login, header, footer, page title); "Dodopo AM" on narrow headers. Tagline "Patrimônio multiativo".
- Repository renamed to `dodopo/dodopo-asset-manager` (GitHub redirects the old address). Package name `dodopo-asset-manager`.
- Backup export: file `dodopo-am-backup_...json`, `app` field "Dodopo Asset Manager". Old backup files still import.
- Data provider requests identify as "DodopoAssetManager (self-hosted)".
- Server templates and updater: `deploy/macos/local.dodopoam.{app,backup}.plist`; `scripts/update.sh` defaults to user `dodopoam` and label `local.dodopoam.app`, settings renamed to `DAM_*` (the old `NYSE_*` names still work).
- Docs (README, SELF_HOSTING) use the new names.

### Kept on purpose
- Session cookie name and browser preference keys keep their internal names, so nobody is logged out and saved filters, currency and moving averages stay.


## [0.11.0] - 2026-11-15

Consolidated view: filter by tab, allocation chart and values in reais. No database migration.

### Added
- **Filter by tab**: chips above the consolidated view ("Todas" plus one per tab, multiple selection). Cards, allocation and table follow the selection; selecting every tab is the same as "Todas".
- **Allocation donut** by market value of open positions, "Por aba" (tab colors) or "Por ativo"; slices under 3% are grouped in "Outros". Drawn in plain SVG (no chart library added).
- **USD | BRL** toggle: values converted at the current dollar rate from Coinbase's public exchange rates (no key, cached 10 min, refreshed while open), with the rate and its time shown ("US$ 1 = R$ 5,6658 · Coinbase, 12:42"). If the rate is unavailable the view stays in dollars and says so; an out-of-range rate is never used. `GET /api/fx/usdbrl`; `COINBASE_RATES_URL` (advanced/testing).
- Filter, currency and allocation choices are remembered in the browser.
- `shared/allocation.ts` (filter and slice rules) and `src/components/Donut.tsx` (reusable).
- Tests: 113 (filter, slices, exchange rate: source, cache, invalid or unavailable rate, login required).

### Notes
- Reais are a display conversion at today's rate (useful for net worth). Income tax uses the Central Bank PTAX rate of specific dates; that is kept for a later version.

## [0.10.3] - 2026-11-15

No database migration.

### Added
- **Full screen shows the asset.** The page header disappears in full screen, so the chart now shows the ticker, the asset name and the live price with its change at the top (e.g. "AAPL · APPLE INC · $356.27 · +0.39%"). The full-screen dialog is also announced with the displayed symbol ("BTC", not "X:BTCUSD").

### Notes
- Final validation of the charts on 15/11 with real data: AAPL (Alpaca) and BTC (Coinbase) on every period and on custom periods. The "Estendido" toggle was checked on the test server (regular session 09:30–15:55 New York; extended 04:00–19:55).

## [0.10.2] - 2026-11-15

Chart axis fixes, validated against real Coinbase data on every period. No database migration.

### Fixed
- **Month and day marks on intraday charts.** The chart library places day and month marks in UTC, and the labels were written in Brazil time, so on 1M the start of November (00:00 UTC = 31/10 21:00 in Brazil) was labeled "out.". Intraday candles are now handed to the chart in local wall-clock time: marks fall on local midnights and month starts, and every label is written in that same frame.
- **Negative prices on the axis on tall screens.** The price area kept a 5% bottom margin, which on long periods starting near zero (BTC since 2015) reached −10,000. The margin is now 2%; the axis ends at 0.

### Added
- Tests: 104 (local-time chart marks around a month boundary).

## [0.10.1] - 2026-11-15

Chart fixes found in real screenshots of v0.10.0. No database migration.

### Fixed
- **Crypto dates one day early.** Coinbase daily, weekly and monthly candles start at 00:00 UTC, which is 21:00 of the previous day in Brazil, so the legend showed "30 de out." for the 31/10 candle, the Máx axis showed "2017" twice without 2018 (and "2023" twice without 2024), and 1A/YTD showed "2025" where 2026 starts. Daily or longer candles are now dated by their own date: UTC for crypto, New York for stocks. Intraday charts keep local time.
- **Crypto buy/sell markers one day late.** Trades were matched to candles by the New York date, so a crypto buy on 29/10 appeared on the 30/10 candle. Crypto now uses the UTC date.
- **Negative prices on the axis** (−10,000 to −50,000 on long periods). Volume now has its own pane below the prices, like TradingView, instead of sharing the price area.
- **False "Dados até …" warning** on a custom period that ends in the past.
- The calendar panel now closes when another period is chosen.

### Added
- Tests: 102 (candle dates per asset type, crypto markers on the right day, year boundaries).

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
