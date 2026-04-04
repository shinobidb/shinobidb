# shinobidb

[![CI](https://github.com/shinobidb/shinobidb/actions/workflows/ci.yml/badge.svg)](https://github.com/shinobidb/shinobidb/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/shinobidb.svg)](https://www.npmjs.com/package/shinobidb)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![npm downloads](https://img.shields.io/npm/dm/shinobidb.svg)](https://www.npmjs.com/package/shinobidb)

[日本語](README.ja.md)

Production database data masking tool for staging environments. Scans your database for PII columns, generates a masking config, and copies data with sensitive fields anonymized.

## Requirements

- Node.js >= 18
- MySQL 8.0+, PostgreSQL 14+, or MongoDB 5.0+

## Installation

```bash
npm install -g shinobidb
```

Or use without installing:

```bash
npx shinobidb --help
```

## Quick Start

### MySQL

```bash
# 1. Scan source database for PII columns
shinobidb scan --host localhost --port 3306 --user root --password secret --schemas mydb

# 2. Generate masking config from scan results
shinobidb config --host localhost --port 3306 --user root --password secret --schemas mydb -o shinobidb.yaml

# 3. Edit shinobidb.yaml — set the target connection (host, port, user, database)
#    The generated file has <TARGET_HOST>, <TARGET_PASSWORD> etc. as placeholders

# 4. Sync: dump → mask → atomic swap (passwords are prompted interactively if omitted)
shinobidb sync --source-password secret --target-password secret
```

### PostgreSQL

```bash
shinobidb scan --type postgres --host localhost --port 5432 --user admin --database mydb --schemas public
shinobidb config --type postgres --host localhost --port 5432 --user admin --database mydb --schemas public -o shinobidb.yaml
# Edit shinobidb.yaml, then:
shinobidb sync --source-password secret --target-password secret
```

### MongoDB

```bash
shinobidb scan --type mongodb --host localhost --port 27017 --user admin --database mydb
shinobidb config --type mongodb --host localhost --port 27017 --user admin --database mydb -o shinobidb.yaml
# Edit shinobidb.yaml, then:
shinobidb sync --source-password secret --target-password secret
```

> **Note:** `--type` defaults to `mysql` when not specified. For PostgreSQL and MongoDB, always pass `--type`.

## CLI Commands

### Connection Options

All commands that connect to a database accept individual flags, a connection URI, or environment variables:

```bash
# Individual flags
shinobidb scan --host localhost --port 3306 --user root --password secret --schemas mydb

# Connection URI (MySQL, PostgreSQL, MongoDB)
shinobidb scan --uri mysql://root:secret@localhost:3306/mydb
shinobidb scan --uri postgres://user:pass@localhost:5432/mydb
shinobidb scan --uri mongodb://user:pass@localhost:27017/mydb

# Environment variables (recommended for CI/CD and production)
export SHINOBIDB_SOURCE_HOST=localhost
export SHINOBIDB_SOURCE_PORT=3306
export SHINOBIDB_SOURCE_USER=root
export SHINOBIDB_SOURCE_PASSWORD=secret
export SHINOBIDB_SOURCE_DATABASE=mydb
export SHINOBIDB_SOURCE_TYPE=mysql    # mysql, postgres, or mongodb
shinobidb scan --schemas mydb
```

For `mask`, target connection uses the `SHINOBIDB_TARGET_*` prefix (same keys: `HOST`, `PORT`, `USER`, `PASSWORD`, `DATABASE`, `TYPE`, `URI`).

**Password resolution order:** CLI flag > environment variable > config file > interactive prompt. If no password is provided, you will be prompted interactively.

> **Security:** Avoid passing passwords via CLI flags (`--password`, `--source-password`, `--target-password`) in production — they are visible to other processes via `ps`. Use environment variables or the interactive prompt instead.

### `shinobidb scan`

Connects to the database, reads the schema, and detects PII columns by column name patterns.

```bash
shinobidb scan \
  --host <host> --port <port> --user <user> --password <password> \
  [--uri <uri>] \
  [--type mysql|postgres|mongodb] [--database <db>] [--schemas <s1,s2>] [--tables <t1,t2>] \
  [--sample-content] [--json]
```

Output includes detected columns with category, confidence score, and suggested masking strategy.

**`--database` vs `--schemas`:**

- **MySQL** — `--schemas` specifies databases to scan (MySQL treats schemas and databases as the same thing). `--database` is optional.
- **PostgreSQL** — `--database` specifies which database to connect to, `--schemas` specifies schema names within it (e.g. `public`).
- **MongoDB** — `--database` specifies the database. `--schemas` is not used.

Use `--sample-content` to also sample actual row data and detect PII by content patterns (emails, phone numbers, IPs, credit card numbers, SSNs). When both column name and content detectors match the same column, the higher-confidence result is kept.

### `shinobidb config`

Runs a scan and generates a `shinobidb.yaml` config file with masking rules pre-filled.

```bash
shinobidb config \
  --host <host> --port <port> --user <user> --password <password> \
  [--uri <uri>] \
  [--type mysql|postgres|mongodb] [--database <db>] [--schemas <s1,s2>] [--tables <t1,t2>] \
  [--sample-content] [--min-confidence <0.0-1.0>] [-o <file>]
```

### `shinobidb sync`

**(Recommended)** Native dump → UPDATE mask → atomic swap. Faster, safer, and simpler than `mask`.

```bash
shinobidb sync \
  [-c <config-file>] \
  --source-password <password> --target-password <password> \
  [--dry-run] [--keep-old] [--keep-dump <path>] [--input-dump <path>] \
  [--concurrency <n>] [--no-progress] \
  [--audit-log <file>] [--json]
```

How it works:

1. **Dump** — `mysqldump` / `pg_dump` / `mongodump` creates a full copy of the source database
2. **Restore** — The dump is restored into a temporary database on the target server
3. **Mask** — PII columns are masked via `UPDATE` statements in the temporary database
4. **Swap** — Atomic swap: temp → target, target → old (zero downtime for the target database)
5. **Cleanup** — The old database is dropped (unless `--keep-old`)

| Option                | Description                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `--dry-run`           | Dump, restore, and mask the temp DB but skip the swap. Temp DB is preserved for inspection |
| `--keep-old`          | Keep the old database after swap (for manual rollback)                                     |
| `--keep-dump <path>`  | Save the dump file to the specified path                                                   |
| `--input-dump <path>` | Restore from an existing dump file instead of dumping from source                          |
| `--concurrency <n>`   | Number of tables to mask in parallel (default: 1)                                          |
| `--no-progress`       | Disable progress bar                                                                       |
| `--audit-log <file>`  | Write audit log to file (JSON or CSV based on extension)                                   |
| `--json`              | Output result as JSON                                                                      |
| `--ci`                | CI mode: disable interactive prompts and progress bar. Exit code 1 on failure              |

**Why sync over mask?**

- **Faster** — Native dump/restore is significantly faster than row-by-row streaming
- **Complete** — Dump includes indexes, triggers, views, stored procedures — no need for `--sync-schema`
- **Simpler config** — Only PII columns need to be defined. Non-PII tables are copied automatically via dump
- **Zero downtime** — Atomic swap means the target database is always available during sync
- `copyOnly` and `incremental` config options are ignored (all tables are copied via dump)

#### Migrating from `mask` to `sync`

If you are currently using `shinobidb mask`, switching to `sync` is straightforward:

1. Replace `shinobidb mask` with `shinobidb sync` in your scripts
2. Remove `--sync-schema` (dump includes the schema)
3. Remove `--full-refresh` (sync always does a full copy)
4. `copyOnly: true` entries in your config are ignored — all tables are copied via dump
5. `incremental` entries are ignored — sync always performs a full dump

Your existing `shinobidb.yaml` works as-is with `sync`. The only change is the command name.

> **Prerequisites:** `sync` requires native database tools to be installed on your system:
>
> - **MySQL:** `mysqldump` and `mysql` client
> - **PostgreSQL:** `pg_dump` and `psql`
> - **MongoDB:** `mongodump` and `mongorestore`

### `shinobidb mask` _(deprecated)_

> **Note:** `mask` is deprecated in favor of `sync`. Use `shinobidb sync` for new setups. See [Migrating from mask to sync](#migrating-from-mask-to-sync) above.

Reads the config file, copies data from source to target, and applies masking strategies.

```bash
shinobidb mask \
  [-c <config-file>] \
  --source-password <password> --target-password <password> \
  [--dry-run] [--sample-rows <n>] [--json] \
  [--concurrency <n>] [--sync-schema] \
  [--audit-log <file>] [--full-refresh] [--no-progress]
```

Passwords are not stored in the config file. Pass them via CLI flags, environment variables (`SHINOBIDB_SOURCE_PASSWORD` / `SHINOBIDB_TARGET_PASSWORD`), or omit them to be prompted interactively. Config file defaults to `shinobidb.yaml` in the current directory.

| Option               | Description                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `--dry-run`          | Preview masking results without writing to target. Shows before/after sample rows for each table |
| `--sample-rows <n>`  | Number of sample rows to show in dry-run output (default: 3)                                     |
| `--json`             | Output dry-run results as JSON                                                                   |
| `--concurrency <n>`  | Number of tables to process in parallel (default: 1)                                             |
| `--sync-schema`      | Auto-create missing tables in target from source schema                                          |
| `--audit-log <file>` | Write audit log to file. Format auto-detected by extension (`.json` or `.csv`)                   |
| `--full-refresh`     | Force full copy for incremental tables, resetting sync state                                     |
| `--no-progress`      | Disable progress bar                                                                             |

### Schema Change Detection

Track PII column changes over time using snapshots:

```bash
# Save a baseline snapshot
shinobidb scan --host localhost --port 3306 --user root --password secret --schemas mydb --snapshot

# Later, compare current schema against the snapshot
shinobidb scan --host localhost --port 3306 --user root --password secret --schemas mydb --diff

# Custom snapshot file paths
shinobidb scan ... --snapshot baseline.json
shinobidb scan ... --diff baseline.json

# Save and diff in one command
shinobidb scan ... --snapshot --diff
```

The diff output shows new, removed, and changed PII columns. Exit code is 1 when changes are detected, making it easy to integrate into CI pipelines.

### `shinobidb drift`

Detect drift between your masking config and the current database schema. Finds new PII columns not covered by your config, tables/columns that no longer exist in the database, and `copy_only` tables that contain PII.

```bash
shinobidb drift <config-path> \
  [--schemas <s1,s2>] [--tables <t1,t2>] \
  [--sample-content] [--min-confidence <0.6>] \
  [--json] [--apply]
```

| Option             | Description                                     |
| ------------------ | ----------------------------------------------- |
| `--json`           | Output as JSON (for CI integration)             |
| `--apply`          | Auto-update config with newly detected entries  |
| `--min-confidence` | Minimum PII confidence threshold (default: 0.5) |
| `--sample-content` | Sample actual row data for PII detection        |

Exit code is 1 when actionable drift (critical or warning) is detected. Use the `ignore` field in your config to suppress known false positives:

```yaml
ignore:
  - mydb.users.display_name
  - mydb.logs.user_agent
```

**CI Integration:** Sample GitHub Actions workflows are available in [`examples/ci/`](examples/ci/):

- [`drift-check.yml`](examples/ci/drift-check.yml) — Scheduled drift detection with Slack notifications
- [`drift-check-pr.yml`](examples/ci/drift-check-pr.yml) — Post drift results as a PR comment when config changes

### `shinobidb validate`

Validate a config file without connecting to any database. Checks for unknown strategies, duplicate tables/columns, incremental column conflicts, and more.

```bash
shinobidb validate [-c <config-file>] [--json]
```

Exit code is 1 when errors are found. Warnings (e.g. cross-DB type mismatch) do not cause failure.

### Global Options

- `-v, --verbose` — Enable debug logging with stack traces on errors

## Config File

Generated by `shinobidb config`, editable by hand:

```yaml
version: '1'
source:
  type: mysql
  host: localhost
  port: 3306
  user: root
  database: production_db
target:
  type: mysql
  host: localhost
  port: 3307
  user: root
  database: staging_db
options:
  batchSize: 1000
  deterministic: true
  seed: shinobidb-default-seed
  truncateTarget: true
tables:
  - schema: production_db
    table: users
    columns:
      - name: email
        strategy: hash_email
      - name: first_name
        strategy: fake_first_name
      - name: last_name
        strategy: fake_last_name
      - name: phone
        strategy: fake_phone
      - name: ip_address
        strategy: hash_ip
      - name: notes
        strategy: scrub_text
```

**Key options:**

- `truncateTarget: true` — **Deletes all existing data** in each target table before copying. Set to `false` to append instead.
- `deterministic: true` — Same input always produces the same masked output (useful for referential integrity).
- `batchSize` — Number of rows processed per batch (default: 1000).

### Copy-Only Tables

Tables without PII can be copied without masking:

```yaml
tables:
  - schema: production_db
    table: categories
    copyOnly: true
```

Use `shinobidb config --include-all-tables` to generate config entries for all tables, with `copyOnly: true` for those where no PII is detected.

### Incremental Sync

Copy only rows changed since the last run, instead of a full copy each time:

```yaml
tables:
  - schema: production_db
    table: orders
    incremental:
      strategy: timestamp # or 'cursor'
      column: updated_at # column to track changes
    columns:
      - name: customer_email
        strategy: hash_email
```

- **`timestamp`** — Syncs rows where the column value is newer than the last run
- **`cursor`** — Syncs rows where the column value is greater than the last cursor position (e.g. auto-increment ID)
- Sync state is saved to `.shinobidb/sync-state.json`
- Use `--full-refresh` to reset state and force a full copy

## Masking Strategies

| Strategy          | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `hash_email`      | Deterministic hash preserving the domain (e.g. `a1b2@example.com`) |
| `fake_name`       | Random full name                                                   |
| `fake_first_name` | Random first name                                                  |
| `fake_last_name`  | Random last name                                                   |
| `fake_phone`      | Random phone number                                                |
| `fake_address`    | Random address                                                     |
| `hash_ip`         | Deterministic hash producing valid IPv4                            |
| `random_date`     | Random date within a configurable range                            |
| `redact`          | Replace with `[REDACTED]`                                          |
| `scrub_text`      | Detect and replace emails, IPs, and phone numbers within free text |

### Custom Strategies

Define your own masking strategies in JS/TS files and reference them from the config:

```yaml
customStrategies:
  - ./my-strategies.js

tables:
  - schema: mydb
    table: users
    columns:
      - name: nickname
        strategy: custom_prefix
        params:
          prefix: 'user'
```

A custom strategy file exports objects with `name` (string) and `mask` (function):

```js
// my-strategies.js — default export (single strategy)
export default {
  name: 'custom_prefix',
  mask(value, context, seed) {
    if (typeof value !== 'string') return value;
    const prefix = context.params?.prefix ?? 'MASKED';
    return `${prefix}_${value}`;
  },
};
```

Multiple strategies can be exported as named exports or as an array:

```js
// multi-strategies.js — named exports
export const maskA = { name: 'mask_a', mask: (v) => /* ... */ };
export const maskB = { name: 'mask_b', mask: (v) => /* ... */ };
```

The `context` parameter provides `schema`, `table`, `column`, `rowIndex`, `primaryKeyValue`, and `params` (from the column config YAML).

## Architecture

```
src/
├── cli.ts                  # CLI entry point (commander)
├── core/
│   ├── scanner.ts          # PII scan orchestration
│   ├── config-generator.ts # Scan result → YAML config
│   ├── config-loader.ts    # YAML config → validated object
│   └── mask-executor.ts    # Masking execution engine
├── db/
│   ├── types.ts            # DatabaseAdapter interface
│   ├── factory.ts          # Adapter factory
│   ├── mysql/              # MySQL implementation
│   ├── postgres/           # PostgreSQL implementation
│   └── mongodb/            # MongoDB implementation (schema inference)
├── detection/
│   ├── detectors/          # PII detection by column name patterns
│   └── detector-factory.ts
├── masking/
│   ├── strategies/         # 10 masking strategy implementations
│   └── strategy-registry.ts
└── shared/
    ├── logger.ts           # Structured logger (no console.log)
    └── errors.ts           # Error hierarchy
```

The database adapter interface (`DatabaseAdapter`) abstracts away database-specific operations. MySQL, PostgreSQL, and MongoDB are supported. MongoDB uses schema inference via document sampling since it has no fixed schema.

## Development

```bash
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
npm test             # Unit tests
```

### E2E Tests

E2E tests run against real database instances via Docker:

```bash
docker compose up -d          # Start MySQL (3307/3308), PostgreSQL (5433/5434), MongoDB (27017/27018)
npm run test:e2e              # Run E2E tests (MySQL + PostgreSQL + MongoDB)
docker compose down           # Cleanup
```

## License

MIT
