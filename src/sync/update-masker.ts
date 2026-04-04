import pLimit from 'p-limit';

import type { DatabaseAdapter } from '../db/types.js';
import type { StrategyRegistry } from '../masking/strategy-registry.js';
import type { MaskingContext } from '../masking/types.js';
import { ShinobiError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

import type { SyncMaskTable, SyncProgressCallback, SyncTableResult } from './types.js';

export interface UpdateMaskOptions {
  batchSize: number;
  deterministic: boolean;
  seed?: string;
  concurrency: number;
  onProgress?: SyncProgressCallback;
}

export interface UpdateMaskResult {
  tablesMasked: number;
  rowsMasked: number;
  tableDetails: SyncTableResult[];
}

/**
 * Mask PII columns in the temp database using UPDATE statements.
 * Flow per table: SELECT (pk + PII columns) → mask in JS → UPDATE via PK.
 * Uses PK value as deterministic seed input (not rowIndex) for stable results.
 */
export async function executeUpdateMask(
  adapter: DatabaseAdapter,
  tables: SyncMaskTable[],
  registry: StrategyRegistry,
  options: UpdateMaskOptions,
): Promise<UpdateMaskResult> {
  const result: UpdateMaskResult = {
    tablesMasked: 0,
    rowsMasked: 0,
    tableDetails: [],
  };

  // Validate: all tables must have PK
  for (const table of tables) {
    if (table.primaryKey.length === 0) {
      throw new ShinobiError(
        `Table "${table.schema}.${table.table}" has no primary key. ` +
          'Primary key is required for UPDATE-based masking in sync mode. ' +
          'Add a primary key to the table, or use "shinobidb mask" (v1 mode) instead.',
        'UPDATE_MASK_NO_PK',
      );
    }
  }

  // Estimate total rows for progress
  let totalEstimatedRows = 0;
  if (options.onProgress) {
    for (const table of tables) {
      const count = await adapter.getRowCount(table.schema, table.table);
      totalEstimatedRows += count;
    }
  }

  const limit = pLimit(options.concurrency);

  const tasks = tables.map((table) =>
    limit(async () => {
      const tableResult = await maskTable(adapter, table, registry, options);
      result.tablesMasked++;
      result.rowsMasked += tableResult.rowsMasked;
      result.tableDetails.push(tableResult);

      options.onProgress?.({
        phase: 'mask',
        message: `Masked ${table.schema}.${table.table}`,
        totalRows: totalEstimatedRows,
        processedRows: result.rowsMasked,
        currentTable: `${table.schema}.${table.table}`,
        tablesTotal: tables.length,
        tablesCompleted: result.tablesMasked,
      });
    }),
  );

  await Promise.all(tasks);
  return result;
}

async function maskTable(
  adapter: DatabaseAdapter,
  table: SyncMaskTable,
  registry: StrategyRegistry,
  options: UpdateMaskOptions,
): Promise<SyncTableResult> {
  const { schema, table: tableName, columns, primaryKey } = table;
  let rowsMasked = 0;

  logger.info(
    `UPDATE masking: ${schema}.${tableName} (${columns.length} column(s), PK: ${primaryKey.join(', ')})`,
  );

  await adapter.readRows(schema, tableName, options.batchSize, async (rows) => {
    const updates: Record<string, unknown>[] = [];

    for (const row of rows) {
      const update: Record<string, unknown> = {};

      // Include PK columns in the update record
      for (const pk of primaryKey) {
        update[pk] = row[pk];
      }

      // Compute PK-based seed for deterministic masking
      const pkValue = primaryKey.length === 1 ? row[primaryKey[0]!] : primaryKey.map((k) => row[k]);

      let hasChanges = false;

      for (const colConfig of columns) {
        if (!(colConfig.name in row)) continue;

        const strategy = registry.get(colConfig.strategy);
        const context: MaskingContext = {
          schema,
          table: tableName,
          column: colConfig.name,
          rowIndex: 0, // Not used for seed in v2; PK value is used instead
          primaryKeyValue: pkValue,
          params: colConfig.params,
        };

        const seed = options.deterministic ? options.seed : undefined;
        const masked = strategy.mask(row[colConfig.name], context, seed);
        update[colConfig.name] = masked;
        hasChanges = true;
      }

      if (hasChanges) {
        updates.push(update);
      }
    }

    if (updates.length > 0) {
      await adapter.updateRows(schema, tableName, updates, primaryKey);
      rowsMasked += updates.length;
    }
  });

  logger.info(`Masked ${rowsMasked} row(s) in ${schema}.${tableName}`);

  return {
    schema,
    table: tableName,
    rowsMasked,
    maskedColumns: columns.map((c) => c.name),
  };
}
