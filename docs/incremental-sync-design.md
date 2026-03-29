# Incremental Sync Design (v1.1)

## Overview

行レベルの増分同期。前回同期以降に追加・更新された行のみをソースからターゲットにコピーする。

## Design Decisions

| #   | Topic               | Decision                                          |
| --- | ------------------- | ------------------------------------------------- |
| 1   | Sync strategy       | timestamp + cursor (per-table)                    |
| 2   | State storage       | Local file `.shinobidb/sync-state.json`           |
| 3   | First run           | Auto full-copy when no state exists               |
| 4   | DELETE handling     | Ignore (use `--full-refresh` to reset)            |
| 5   | Schema changes      | Error + suggest `--full-refresh`                  |
| 6   | Config default      | `incremental` unset = full copy (backward compat) |
| 7   | Adapter change      | Add optional `filter?` param to `readRows`        |
| 8   | Masking consistency | Use PK value in seed (not rowIndex)               |
| 9   | Write mode          | UPSERT (INSERT ON CONFLICT UPDATE)                |

## Sync Strategies

### timestamp

`WHERE updated_at > last_cursor ORDER BY updated_at ASC`

- For tables with an `updated_at` (or equivalent) column
- Cursor stores the max `updated_at` value from the last sync

### cursor

`WHERE id > last_cursor ORDER BY id ASC`

- For append-only tables (logs, events)
- Cursor stores the max PK value from the last sync

## Config YAML

```yaml
tables:
  - schema: mydb
    table: users
    columns:
      - name: email
        strategy: hash
    incremental:
      strategy: timestamp # "timestamp" | "cursor"
      column: updated_at # column to filter on
  - schema: mydb
    table: access_logs
    copyOnly: true
    incremental:
      strategy: cursor
      column: id
```

`incremental` omitted = full copy (backward compatible).

## State File

Location: `.shinobidb/sync-state.json`

```json
{
  "version": 1,
  "sourceFingerprint": "hash-of-connection-config",
  "tables": {
    "mydb.users": {
      "strategy": "timestamp",
      "cursor": "2026-03-28T12:00:00Z",
      "lastSyncedAt": "2026-03-29T00:00:00Z",
      "rowsSynced": 1500
    },
    "mydb.access_logs": {
      "strategy": "cursor",
      "cursor": "98234",
      "lastSyncedAt": "2026-03-29T00:00:00Z",
      "rowsSynced": 50000
    }
  }
}
```

## DatabaseAdapter Changes

```typescript
// New type
interface ReadFilter {
  column: string;
  operator: '>' | '>=';
  value: string | number | Date;
  orderBy: 'ASC';
}

// Modified signature
readRows(
  schema: string,
  table: string,
  batchSize: number,
  onBatch: (rows: Record<string, unknown>[]) => Promise<boolean | void>,
  filter?: ReadFilter,  // NEW: optional
): Promise<void>;
```

Each adapter appends `WHERE column > value ORDER BY column ASC` when filter is provided.

## UPSERT (New Method)

```typescript
// New method on DatabaseAdapter
upsertRows(
  schema: string,
  table: string,
  rows: Record<string, unknown>[],
  primaryKey: string | string[],
): Promise<void>;
```

- MySQL: `INSERT ... ON DUPLICATE KEY UPDATE`
- PostgreSQL: `INSERT ... ON CONFLICT (pk) DO UPDATE SET ...`
- MongoDB: `bulkWrite` with `updateOne({ upsert: true })`

## MaskingContext Changes

```typescript
interface MaskingContext {
  schema: string;
  table: string;
  column: string;
  rowIndex: number;
  primaryKeyValue?: unknown; // NEW: used for deterministic masking in incremental
}
```

When `primaryKeyValue` is set, deterministic masking uses it instead of `rowIndex` for seed generation.

## CLI Flags

- `--full-refresh` — Force full copy, reset sync state
- No `--incremental` flag needed. Behavior is driven by config YAML.

## Execution Flow

```
shinobidb mask
  ├── Read config YAML
  ├── Load sync-state.json (or empty)
  ├── For each table:
  │   ├── Has incremental config?
  │   │   ├── NO  → full copy (truncate + insert, as today)
  │   │   └── YES → Has state entry?
  │   │       ├── NO  → full copy → save cursor
  │   │       └── YES → Check schema match
  │   │           ├── MISMATCH → error + suggest --full-refresh
  │   │           └── OK → readRows with filter → upsertRows → update cursor
  │   └── Update progress
  └── Save sync-state.json
```

## Implementation Order

1. Config types — `IncrementalConfig` in `config/types.ts`
2. Sync state — read/write module in `core/sync-state.ts`
3. ReadFilter + readRows filter param — `db/types.ts` + 3 adapters
4. upsertRows — `db/types.ts` + 3 adapters
5. MaskingContext — add `primaryKeyValue`, update seed logic
6. mask-executor — incremental flow integration
7. CLI — `--full-refresh` flag
8. Tests at each step
