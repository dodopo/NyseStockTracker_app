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
