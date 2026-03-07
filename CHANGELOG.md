# Changelog
All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project aims to follow Semantic Versioning (SemVer).

## [Unreleased]

### Added
- In-memory quote cache for Finnhub market data.
- Configurable cache TTL through the `QUOTE_CACHE_TTL_MS` environment variable.
- Debug response headers for quote requests:
  - `X-Cache: HIT | MISS`
  - `X-Cache-TTL-MS`

### Changed
- Refactored `/api/quote` to reuse cached Finnhub responses when available.
- Refactored `/api/prices` to use the same internal cached quote logic instead of calling `localhost` in a loop.

### Fixed
-


## [0.1.1] - 2026-03-01
### Fixed
- Correct P/L toggle behavior (Unificado vs Separado) in Consolidated view.

### Changed
- Updated README (technologies and execution instructions).
    - Corrected tech stack description (removed Vite as runtime assumption)
    - Clarified how to run the development server 


## [0.1.0] - 2026-03-01
### Added
- Initial tracked version of the app in this repository, as currently working on `main`.
- Core tracking UI and initial features already implemented up to this point.

### Notes
- This is the baseline version we will tag later as the first stable release.
