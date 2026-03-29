import pLimit from 'p-limit';

import type { ShinobiConfig, TableMaskConfig } from '../config/types.js';
import type { DatabaseAdapter, ReadFilter } from '../db/types.js';
import type { StrategyRegistry } from '../masking/strategy-registry.js';
import type { MaskingContext } from '../masking/types.js';
import { ShinobiError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

import {
  createEmptySyncState,
  createSourceFingerprint,
  getTableKey,
  getSyncStatePath,
  loadSyncState,
  saveSyncState,
} from './sync-state.js';
import type { SyncState, TableSyncState } from './sync-state.js';

export interface TableResult {
  schema: string;
  table: string;
  rowsProcessed: number;
  rowsWritten: number;
  copyOnly: boolean;
  maskedColumns: string[];
}

export interface MaskResult {
  tablesProcessed: number;
  rowsProcessed: number;
  rowsWritten: number;
  tableDetails: TableResult[];
}

export interface DryRunSampleRow {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface DryRunTableResult {
  schema: string;
  table: string;
  copyOnly: boolean;
  rowCount: number;
  samples: DryRunSampleRow[];
}

export interface DryRunResult {
  tables: DryRunTableResult[];
  totalRows: number;
}

export interface ProgressInfo {
  totalRows: number;
  processedRows: number;
  currentTable: string;
  tablesTotal: number;
  tablesCompleted: number;
}

export type ProgressCallback = (info: ProgressInfo) => void;

export interface MaskExecuteOptions {
  syncSchema?: boolean;
  concurrency?: number;
  onProgress?: ProgressCallback;
  fullRefresh?: boolean;
  syncStateDir?: string;
}

export async function executeMask(
  source: DatabaseAdapter,
  target: DatabaseAdapter,
  config: ShinobiConfig,
  registry: StrategyRegistry,
  options: MaskExecuteOptions = {},
): Promise<MaskResult> {
  const result: MaskResult = {
    tablesProcessed: 0,
    rowsProcessed: 0,
    rowsWritten: 0,
    tableDetails: [],
  };

  const tableCount = config.tables.length;
  logger.info(`Starting mask: ${tableCount} table(s) to process`);

  // MySQL and MongoDB use database name as schema; PostgreSQL uses real schema names
  const targetSchema = config.target.type === 'postgres' ? undefined : config.target.database;

  // Load or create sync state for incremental sync
  const hasIncrementalTables = config.tables.some((t) => t.incremental);
  const syncStatePath = getSyncStatePath(options.syncStateDir);
  const sourceFingerprint = createSourceFingerprint(config.source);
  let syncState: SyncState | null = null;

  if (hasIncrementalTables && !options.fullRefresh) {
    syncState = await loadSyncState(syncStatePath);
    if (syncState && syncState.sourceFingerprint !== sourceFingerprint) {
      logger.warn(
        'Source connection has changed since last sync. Running full refresh for incremental tables.',
      );
      syncState = null;
    }
  }

  if (!syncState) {
    syncState = createEmptySyncState(sourceFingerprint);
  }

  // Estimate total rows for progress
  let totalEstimatedRows = 0;
  if (options.onProgress) {
    const estimates = await Promise.all(
      config.tables.map((t) => source.getRowCount(t.schema, t.table)),
    );
    totalEstimatedRows = estimates.reduce((sum, n) => sum + n, 0);
  }

  const emitProgress = (currentTable: string) => {
    options.onProgress?.({
      totalRows: totalEstimatedRows,
      processedRows: result.rowsProcessed,
      currentTable,
      tablesTotal: tableCount,
      tablesCompleted: result.tablesProcessed,
    });
  };

  // Pre-check: ensure all target tables exist (or create them)
  // This must be sequential before parallel processing starts
  const tableSchemaMap = new Map<string, string>();
  for (const tableConfig of config.tables) {
    const targetSchemaName = targetSchema ?? tableConfig.schema;
    tableSchemaMap.set(`${tableConfig.schema}.${tableConfig.table}`, targetSchemaName);

    const exists = await target.tableExists(targetSchemaName, tableConfig.table);
    if (!exists) {
      if (options.syncSchema) {
        logger.info(`Creating table ${targetSchemaName}.${tableConfig.table} from source schema`);
        const columns = await source.getColumns(tableConfig.schema, tableConfig.table);
        await target.createTable(targetSchemaName, tableConfig.table, columns);
      } else {
        throw new ShinobiError(
          'TABLE_NOT_FOUND',
          `Target table "${targetSchemaName}.${tableConfig.table}" does not exist. ` +
            'Use --sync-schema to auto-create tables from source.',
        );
      }
    }

    // For incremental tables with existing state, skip truncation
    const tableKey = getTableKey(tableConfig.schema, tableConfig.table);
    const isIncremental = !!tableConfig.incremental && !options.fullRefresh;
    const hasState = !!syncState.tables[tableKey];

    if (config.options.truncateTarget && exists && !(isIncremental && hasState)) {
      logger.debug(`Truncating target: ${targetSchemaName}.${tableConfig.table}`);
      await target.truncateTable(targetSchemaName, tableConfig.table);
    }
  }

  // Get primary key info for tables that need incremental sync
  const tablePrimaryKeys = new Map<string, string[]>();
  for (const tableConfig of config.tables) {
    if (tableConfig.incremental) {
      const columns = await source.getColumns(tableConfig.schema, tableConfig.table);
      const pkColumns = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
      if (pkColumns.length === 0) {
        throw new ShinobiError(
          'INCREMENTAL_NO_PK',
          `Table "${tableConfig.schema}.${tableConfig.table}" has no primary key. ` +
            'Primary key is required for incremental sync (upsert).',
        );
      }
      tablePrimaryKeys.set(getTableKey(tableConfig.schema, tableConfig.table), pkColumns);

      // Verify target table also has PK (required for upsert operations)
      const targetSchemaName = tableSchemaMap.get(
        getTableKey(tableConfig.schema, tableConfig.table),
      )!;
      const targetColumns = await target.getColumns(targetSchemaName, tableConfig.table);
      const targetPkColumns = targetColumns.filter((c) => c.isPrimaryKey);
      if (targetPkColumns.length === 0) {
        throw new ShinobiError(
          'TARGET_NO_PK',
          `Target table "${targetSchemaName}.${tableConfig.table}" has no primary key. ` +
            'Primary key is required on target for incremental sync (upsert).',
        );
      }
    }
  }

  const concurrency = options.concurrency ?? 1;
  const limit = pLimit(concurrency);

  const tasks = config.tables.map((tableConfig) => {
    const targetSchemaName = tableSchemaMap.get(`${tableConfig.schema}.${tableConfig.table}`)!;
    const tableKey = getTableKey(tableConfig.schema, tableConfig.table);
    const isIncremental = !!tableConfig.incremental && !options.fullRefresh;
    const tableState = isIncremental ? syncState.tables[tableKey] : undefined;

    return limit(async () => {
      let tableRowsProcessed = 0;
      let tableRowsWritten = 0;

      const onBatchDone = (rowCount: number) => {
        tableRowsProcessed += rowCount;
        tableRowsWritten += rowCount;
        result.rowsProcessed += rowCount;
        result.rowsWritten += rowCount;
        emitProgress(`${tableConfig.schema}.${tableConfig.table}`);
      };

      // Track max cursor value for incremental tables
      let maxCursor = syncState.tables[tableKey]?.cursor ?? '';
      const cursorTracker = tableConfig.incremental
        ? (rows: Record<string, unknown>[]) => {
            if (rows.length > 0) {
              const lastRow = rows[rows.length - 1]!;
              maxCursor = serializeCursor(lastRow[tableConfig.incremental!.column] ?? maxCursor);
            }
          }
        : undefined;

      if (tableConfig.copyOnly) {
        if (isIncremental && tableState) {
          await copyTableIncremental(
            source,
            target,
            tableConfig,
            targetSchemaName,
            config,
            tableState,
            tablePrimaryKeys.get(tableKey)!,
            onBatchDone,
          );
        } else {
          await copyTable(
            source,
            target,
            tableConfig,
            targetSchemaName,
            config,
            onBatchDone,
            cursorTracker,
          );
        }
      } else if (isIncremental && tableState) {
        await processTableIncremental(
          source,
          target,
          tableConfig,
          targetSchemaName,
          config,
          registry,
          tableState,
          tablePrimaryKeys.get(tableKey)!,
          onBatchDone,
        );
      } else {
        await processTable(
          source,
          target,
          tableConfig,
          targetSchemaName,
          config,
          registry,
          onBatchDone,
          cursorTracker,
        );
      }

      // Update sync state for incremental tables
      if (tableConfig.incremental) {
        // For incremental with existing state, cursor was updated by the incremental functions
        const cursor = tableState ? tableState.cursor : maxCursor;
        syncState.tables[tableKey] = {
          strategy: tableConfig.incremental.strategy,
          cursor,
          lastSyncedAt: new Date().toISOString(),
          rowsSynced: tableRowsProcessed,
        };
      }

      result.tableDetails.push({
        schema: tableConfig.schema,
        table: tableConfig.table,
        rowsProcessed: tableRowsProcessed,
        rowsWritten: tableRowsWritten,
        copyOnly: !!tableConfig.copyOnly,
        maskedColumns: tableConfig.copyOnly ? [] : tableConfig.columns.map((c) => c.name),
      });
      result.tablesProcessed++;
      emitProgress(`${tableConfig.schema}.${tableConfig.table}`);
    });
  });

  await Promise.all(tasks);

  // Save sync state if any incremental tables exist
  if (hasIncrementalTables) {
    await saveSyncState(syncStatePath, syncState);
  }

  logger.success(
    `Mask complete: ${result.tablesProcessed} table(s), ${result.rowsProcessed} row(s) processed, ${result.rowsWritten} row(s) written`,
  );

  return result;
}

export async function executeDryRun(
  source: DatabaseAdapter,
  config: ShinobiConfig,
  registry: StrategyRegistry,
  sampleRows: number = 3,
): Promise<DryRunResult> {
  const dryRunResult: DryRunResult = {
    tables: [],
    totalRows: 0,
  };

  logger.info(`Dry run: ${config.tables.length} table(s) to preview`);

  for (const tableConfig of config.tables) {
    const { schema, table } = tableConfig;
    const isCopyOnly = !!tableConfig.copyOnly;
    const rowCount = await source.getRowCount(schema, table);
    const samples: DryRunSampleRow[] = [];
    const collectAll = sampleRows === 0;
    const maxSamples = collectAll ? Infinity : sampleRows;

    if (!isCopyOnly) {
      await source.readRows(schema, table, config.options.batchSize, async (rows) => {
        for (const row of rows) {
          if (samples.length >= maxSamples) return;
          const masked = maskRow(row, tableConfig, config, registry, samples.length);
          samples.push({ before: row, after: masked });
        }
      });
    }

    dryRunResult.tables.push({
      schema,
      table,
      copyOnly: isCopyOnly,
      rowCount,
      samples,
    });
    dryRunResult.totalRows += rowCount;
  }

  return dryRunResult;
}

async function copyTable(
  source: DatabaseAdapter,
  target: DatabaseAdapter,
  tableConfig: TableMaskConfig,
  targetSchema: string,
  config: ShinobiConfig,
  onBatchDone: (rowCount: number) => void,
  onCursorTrack?: (rows: Record<string, unknown>[]) => void,
): Promise<void> {
  const { schema, table } = tableConfig;
  logger.info(`Copying ${schema}.${table} → ${targetSchema}.${table} (no masking)`);

  await source.readRows(schema, table, config.options.batchSize, async (rows) => {
    if (rows.length > 0) {
      await target.writeRows(targetSchema, table, rows);
    }
    onCursorTrack?.(rows);
    onBatchDone(rows.length);
  });
}

async function copyTableIncremental(
  source: DatabaseAdapter,
  target: DatabaseAdapter,
  tableConfig: TableMaskConfig,
  targetSchema: string,
  config: ShinobiConfig,
  tableState: TableSyncState,
  primaryKey: string[],
  onBatchDone: (rowCount: number) => void,
): Promise<void> {
  const { schema, table } = tableConfig;
  const inc = tableConfig.incremental!;

  const filter: ReadFilter = {
    column: inc.column,
    operator: '>',
    value: deserializeCursorValue(tableState.cursor, inc.strategy),
    orderBy: 'ASC',
  };

  logger.info(
    `Incremental copy ${schema}.${table} → ${targetSchema}.${table} (${inc.strategy}: ${inc.column} > ${tableState.cursor})`,
  );

  let maxCursor = tableState.cursor;

  await source.readRows(
    schema,
    table,
    config.options.batchSize,
    async (rows) => {
      if (rows.length > 0) {
        await target.upsertRows(targetSchema, table, rows, primaryKey);
        const lastRow = rows[rows.length - 1]!;
        maxCursor = serializeCursor(lastRow[inc.column] ?? maxCursor);
      }
      onBatchDone(rows.length);
    },
    filter,
  );

  tableState.cursor = maxCursor;
}

async function processTableIncremental(
  source: DatabaseAdapter,
  target: DatabaseAdapter,
  tableConfig: TableMaskConfig,
  targetSchema: string,
  config: ShinobiConfig,
  registry: StrategyRegistry,
  tableState: TableSyncState,
  primaryKey: string[],
  onBatchDone: (rowCount: number) => void,
): Promise<void> {
  const { schema, table, columns } = tableConfig;
  const inc = tableConfig.incremental!;

  const filter: ReadFilter = {
    column: inc.column,
    operator: '>',
    value: deserializeCursorValue(tableState.cursor, inc.strategy),
    orderBy: 'ASC',
  };

  let rowIndex = 0;
  let maxCursor = tableState.cursor;

  logger.info(
    `Incremental processing ${schema}.${table} → ${targetSchema}.${table} (${inc.strategy}: ${inc.column} > ${tableState.cursor}, ${columns.length} column(s) to mask)`,
  );

  await source.readRows(
    schema,
    table,
    config.options.batchSize,
    async (rows) => {
      const maskedRows = rows.map((row, i) => {
        const pkValue =
          primaryKey.length === 1 ? row[primaryKey[0]!] : primaryKey.map((k) => row[k]);
        return maskRow(row, tableConfig, config, registry, rowIndex + i, pkValue);
      });

      if (maskedRows.length > 0) {
        await target.upsertRows(targetSchema, table, maskedRows, primaryKey);
        const lastRow = rows[rows.length - 1]!;
        maxCursor = serializeCursor(lastRow[inc.column] ?? maxCursor);
      }

      rowIndex += rows.length;
      onBatchDone(rows.length);
    },
    filter,
  );

  tableState.cursor = maxCursor;
}

async function processTable(
  source: DatabaseAdapter,
  target: DatabaseAdapter,
  tableConfig: TableMaskConfig,
  targetSchema: string,
  config: ShinobiConfig,
  registry: StrategyRegistry,
  onBatchDone: (rowCount: number) => void,
  onCursorTrack?: (rows: Record<string, unknown>[]) => void,
): Promise<void> {
  const { schema, table, columns } = tableConfig;
  let rowIndex = 0;
  logger.info(
    `Processing ${schema}.${table} → ${targetSchema}.${table} (${columns.length} column(s) to mask)`,
  );

  await source.readRows(schema, table, config.options.batchSize, async (rows) => {
    const maskedRows = rows.map((row, i) =>
      maskRow(row, tableConfig, config, registry, rowIndex + i),
    );

    if (maskedRows.length > 0) {
      await target.writeRows(targetSchema, table, maskedRows);
    }

    onCursorTrack?.(rows);
    rowIndex += rows.length;
    onBatchDone(rows.length);
  });
}

function deserializeCursorValue(
  cursor: string,
  strategy: 'timestamp' | 'cursor',
): string | number | Date {
  if (strategy === 'cursor') {
    return Number(cursor);
  }
  // For timestamp strategy, try to parse back to Date for DB adapters
  // that require native Date objects (e.g. MongoDB)
  const parsed = new Date(cursor);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  return cursor;
}

function serializeCursor(value: unknown): string {
  if (value instanceof Date) {
    // Use local timezone format (YYYY-MM-DD HH:MM:SS) so the value can be
    // passed back to the DB as a filter parameter without timezone mismatch.
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
      `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
    );
  }
  return String(value);
}

function maskRow(
  row: Record<string, unknown>,
  tableConfig: TableMaskConfig,
  config: ShinobiConfig,
  registry: StrategyRegistry,
  rowIndex: number,
  primaryKeyValue?: unknown,
): Record<string, unknown> {
  const masked = { ...row };

  for (const colConfig of tableConfig.columns) {
    if (!(colConfig.name in masked)) {
      continue;
    }

    const strategy = registry.get(colConfig.strategy);
    const context: MaskingContext = {
      schema: tableConfig.schema,
      table: tableConfig.table,
      column: colConfig.name,
      rowIndex,
      primaryKeyValue,
    };

    const seed = config.options.deterministic ? config.options.seed : undefined;
    masked[colConfig.name] = strategy.mask(masked[colConfig.name], context, seed);
  }

  return masked;
}
