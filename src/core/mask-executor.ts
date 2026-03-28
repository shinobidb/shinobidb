import pLimit from 'p-limit';

import type { ShinobiConfig, TableMaskConfig } from '../config/types.js';
import type { DatabaseAdapter } from '../db/types.js';
import type { StrategyRegistry } from '../masking/strategy-registry.js';
import type { MaskingContext } from '../masking/types.js';
import { ShinobiError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

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

    if (config.options.truncateTarget && exists) {
      logger.debug(`Truncating target: ${targetSchemaName}.${tableConfig.table}`);
      await target.truncateTable(targetSchemaName, tableConfig.table);
    }
  }

  const concurrency = options.concurrency ?? 1;
  const limit = pLimit(concurrency);

  const tasks = config.tables.map((tableConfig) => {
    const targetSchemaName = tableSchemaMap.get(`${tableConfig.schema}.${tableConfig.table}`)!;

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

      if (tableConfig.copyOnly) {
        await copyTable(source, target, tableConfig, targetSchemaName, config, onBatchDone);
      } else {
        await processTable(
          source,
          target,
          tableConfig,
          targetSchemaName,
          config,
          registry,
          onBatchDone,
        );
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
): Promise<void> {
  const { schema, table } = tableConfig;
  logger.info(`Copying ${schema}.${table} → ${targetSchema}.${table} (no masking)`);

  await source.readRows(schema, table, config.options.batchSize, async (rows) => {
    if (rows.length > 0) {
      await target.writeRows(targetSchema, table, rows);
    }
    onBatchDone(rows.length);
  });
}

async function processTable(
  source: DatabaseAdapter,
  target: DatabaseAdapter,
  tableConfig: TableMaskConfig,
  targetSchema: string,
  config: ShinobiConfig,
  registry: StrategyRegistry,
  onBatchDone: (rowCount: number) => void,
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

    rowIndex += rows.length;
    onBatchDone(rows.length);
  });
}

function maskRow(
  row: Record<string, unknown>,
  tableConfig: TableMaskConfig,
  config: ShinobiConfig,
  registry: StrategyRegistry,
  rowIndex: number,
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
    };

    const seed = config.options.deterministic ? config.options.seed : undefined;
    masked[colConfig.name] = strategy.mask(masked[colConfig.name], context, seed);
  }

  return masked;
}
