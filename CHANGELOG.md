# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `validate` command — check config files for errors and warnings without connecting to a database
- Custom masking strategies — define your own strategies in JS/TS files via `customStrategies` config field
- `params` support in column config, passed to strategies via `MaskingContext`
- Incremental sync (row-level) with timestamp/cursor strategies and upsert writes
- Audit log output (`--audit-log`) in JSON/CSV format
- Progress bar and parallel table processing (`--concurrency`)
- Agent integration section in roadmap (MCP Server, AI config generation)

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

[Unreleased]: https://github.com/shinobidb/shinobidb/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/shinobidb/shinobidb/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/shinobidb/shinobidb/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/shinobidb/shinobidb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/shinobidb/shinobidb/releases/tag/v0.1.0
