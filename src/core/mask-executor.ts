import type { ShinobiConfig, TableMaskConfig } from '../config/types.js';
import type { DatabaseAdapter } from '../db/types.js';
import type { StrategyRegistry } from '../masking/strategy-registry.js';
import type { MaskingContext } from '../masking/types.js';
import { logger } from '../shared/logger.js';

export interface MaskResult {
  tablesProcessed: number;
  rowsProcessed: number;
  rowsWritten: number;
}

export async function executeMask(
  source: DatabaseAdapter,
  target: DatabaseAdapter,
  config: ShinobiConfig,
  registry: StrategyRegistry,
): Promise<MaskResult> {
  const result: MaskResult = {
    tablesProcessed: 0,
    rowsProcessed: 0,
    rowsWritten: 0,
  };

  logger.info(`Starting mask: ${config.tables.length} table(s) to process`);

  const targetSchema = config.target.database;

  for (const tableConfig of config.tables) {
    const targetSchemaName = targetSchema ?? tableConfig.schema;

    if (config.options.truncateTarget) {
      logger.debug(`Truncating target: ${targetSchemaName}.${tableConfig.table}`);
      await target.truncateTable(targetSchemaName, tableConfig.table);
    }

    await processTable(source, target, tableConfig, targetSchemaName, config, registry, result);
    result.tablesProcessed++;
  }

  logger.success(
    `Mask complete: ${result.tablesProcessed} table(s), ${result.rowsProcessed} row(s) processed, ${result.rowsWritten} row(s) written`,
  );

  return result;
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
