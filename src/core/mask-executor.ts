import type { ShinobiConfig, TableMaskConfig } from '../config/types.js';
import type { DatabaseAdapter } from '../db/types.js';
import type { StrategyRegistry } from '../masking/strategy-registry.js';
import type { MaskingContext } from '../masking/types.js';
import { ShinobiError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

export interface MaskResult {
  tablesProcessed: number;
  rowsProcessed: number;
  rowsWritten: number;
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

export interface MaskExecuteOptions {
  syncSchema?: boolean;
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
  };

  logger.info(`Starting mask: ${config.tables.length} table(s) to process`);

  // MySQL and MongoDB use database name as schema; PostgreSQL uses real schema names
  const targetSchema = config.target.type === 'postgres' ? undefined : config.target.database;

  for (const tableConfig of config.tables) {
    const targetSchemaName = targetSchema ?? tableConfig.schema;

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

    if (tableConfig.copyOnly) {
      await copyTable(source, target, tableConfig, targetSchemaName, config, result);
    } else {
      await processTable(source, target, tableConfig, targetSchemaName, config, registry, result);
    }
    result.tablesProcessed++;
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
  result: MaskResult,
): Promise<void> {
  const { schema, table } = tableConfig;
  logger.info(`Copying ${schema}.${table} → ${targetSchema}.${table} (no masking)`);

  await source.readRows(schema, table, config.options.batchSize, async (rows) => {
    if (rows.length > 0) {
      await target.writeRows(targetSchema, table, rows);
      result.rowsWritten += rows.length;
    }
    result.rowsProcessed += rows.length;
  });
}

async function processTable(
  source: DatabaseAdapter,
  target: DatabaseAdapter,
  tableConfig: TableMaskConfig,
  targetSchema: string,
  config: ShinobiConfig,
  registry: StrategyRegistry,
  result: MaskResult,
): Promise<void> {
  const { schema, table, columns } = tableConfig;
  logger.info(
    `Processing ${schema}.${table} → ${targetSchema}.${table} (${columns.length} column(s) to mask)`,
  );

  await source.readRows(schema, table, config.options.batchSize, async (rows) => {
    const maskedRows = rows.map((row, rowIndex) =>
      maskRow(row, tableConfig, config, registry, result.rowsProcessed + rowIndex),
    );

    if (maskedRows.length > 0) {
      await target.writeRows(targetSchema, table, maskedRows);
      result.rowsWritten += maskedRows.length;
    }

    result.rowsProcessed += rows.length;
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
