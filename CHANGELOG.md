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
