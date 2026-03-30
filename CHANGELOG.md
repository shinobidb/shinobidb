# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-03-30

### Added

- `drift` command — detect schema drift between masking config and current database PII
  - Five drift types: `copyonly_has_pii` (CRITICAL), `new_pii_column` (WARNING), `column_not_in_db` (WARNING), `table_not_in_db` (WARNING), `strategy_mismatch` (INFO)
  - `--json` output for CI integration
  - `--apply` flag to auto-update config with newly detected entries (comment-preserving YAML patch)
  - `--min-confidence` threshold and `--sample-content` support
  - Exit code 1 when actionable drift is detected
- `ignore` field in config — suppress known false positives from drift detection (e.g. `ignore: ["mydb.users.display_name"]`)
- CI integration examples (`examples/ci/`):
  - `drift-check.yml` — scheduled drift detection with Slack notifications
  - `drift-check-pr.yml` — post drift results as PR comments on config changes

## [1.0.0] - 2026-03-30

### Added

- `validate` command — check config files for errors and warnings without connecting to a database
- Custom masking strategies — define your own strategies in JS/TS files via `customStrategies` config field
- `params` support in column config, passed to strategies via `MaskingContext`
- Incremental sync (row-level) with timestamp/cursor strategies and upsert writes
- Audit log output (`--audit-log`) in JSON/CSV format
- Progress bar and parallel table processing (`--concurrency`)
- Schema sync (`--sync-schema`) — auto-create missing tables in target from source
- Connection URI support (`--uri`) for MySQL, PostgreSQL, MongoDB
- Content-based PII detection (`--sample-content`) — emails, phones, IPs, credit cards, SSNs
- Environment variable support (`SHINOBIDB_SOURCE_*` / `SHINOBIDB_TARGET_*`)
- Config file connection and interactive password prompt
- Dry-run mode (`--dry-run`) with before/after sample rows
- Copy-only tables (`copyOnly: true`)
- Schema change detection with snapshots (`--snapshot`, `--diff`)
- Japanese documentation (README.ja.md)
- Large-scale benchmark script (1M rows, 50 tables)

### Fixed

- SQL injection prevention for DEFAULT values in CREATE TABLE (MySQL/PostgreSQL)
- Runtime validation for filter operators in incremental sync queries
- Credential leakage in URI parse error messages and debug stack traces
- MySQL string DEFAULT values now properly quoted in schema sync
- `--concurrency` flag parsing (Commander parseInt radix issue)
- Timezone-independent cursor serialization in incremental sync (ISO 8601 UTC)

### Security

- npm audit: 0 vulnerabilities
- All SQL values use parameterized queries
- Passwords excluded from audit logs and sync-state fingerprints
- Password security warning added to documentation

## [0.3.1] - 2025-05-17

### Fixed

- MongoDB mask writing to wrong database on target

## [0.3.0] - 2025-05-17

### Added

- MongoDB adapter with schema inference and full test coverage
- MongoDB support in CLI (`--type mongodb`)

### Changed

- Updated CI: actions v5, skip redundant prepublishOnly in publish

## [0.2.0] - 2025-05-15

### Added

- Schema change detection with scan snapshots and diff (`--snapshot`, `--diff`)
- GitHub Actions publish workflow with npm Trusted Publishing

## [0.1.0] - 2025-05-14

### Added

- Initial release
- PII column detection by column name patterns (`scan` command)
- Config generation from scan results (`config` command)
- Data masking with 10 built-in strategies (`mask` command)
- MySQL and PostgreSQL adapters
- E2E test infrastructure
- CLI with `scan`, `config`, `mask` commands
- Deterministic masking with seed support
- `scrub_text` strategy for free-text PII removal

[Unreleased]: https://github.com/shinobidb/shinobidb/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/shinobidb/shinobidb/compare/v0.3.1...v1.0.0
[0.3.1]: https://github.com/shinobidb/shinobidb/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/shinobidb/shinobidb/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/shinobidb/shinobidb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/shinobidb/shinobidb/releases/tag/v0.1.0
