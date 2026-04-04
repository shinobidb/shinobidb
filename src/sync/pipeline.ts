import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShinobiConfig } from '../config/types.js';
import { createAdapter } from '../db/factory.js';
import type { DatabaseAdapter } from '../db/types.js';
import type { StrategyRegistry } from '../masking/strategy-registry.js';
import { ShinobiError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

import { MongoDumpRestore, MongoSwap } from './mongodb-sync.js';
import { MySQLDumpRestore, MySQLSwap } from './mysql-sync.js';
import { PostgresDumpRestore, PostgresSwap } from './postgres-sync.js';
import { generateOldDbName, generateTempDbName } from './temp-db.js';
import type {
  DumpRestoreProvider,
  SwapProvider,
  SyncMaskTable,
  SyncOptions,
  SyncResult,
} from './types.js';
import { executeUpdateMask } from './update-masker.js';

function createDumpRestoreProvider(dbType: string, sourceDbName?: string): DumpRestoreProvider {
  switch (dbType) {
    case 'mysql':
      return new MySQLDumpRestore();
    case 'postgres':
      return new PostgresDumpRestore();
    case 'mongodb':
      return new MongoDumpRestore(sourceDbName);
    default:
      throw new ShinobiError(`Unsupported database type: ${dbType}`, 'UNSUPPORTED');
  }
}

function createSwapProvider(dbType: string): SwapProvider {
  switch (dbType) {
    case 'mysql':
      return new MySQLSwap();
    case 'postgres':
      return new PostgresSwap();
    case 'mongodb':
      return new MongoSwap();
    default:
      throw new ShinobiError(`Unsupported database type: ${dbType}`, 'UNSUPPORTED');
  }
}

/**
 * Extract tables that need masking from config.
 * Tables with copyOnly or no columns are skipped (they're already in the dump).
 * Resolves primary keys from the temp database.
 */
async function resolveMaskTables(
  config: ShinobiConfig,
  tempAdapter: DatabaseAdapter,
  tempDbName: string,
  dumpProvider: DumpRestoreProvider,
): Promise<SyncMaskTable[]> {
  const maskTables: SyncMaskTable[] = [];

  for (const tableConfig of config.tables) {
    // Skip copyOnly tables — everything is copied via dump
    if (tableConfig.copyOnly) {
      logger.debug(`Skipping copyOnly table: ${tableConfig.schema}.${tableConfig.table}`);
      continue;
    }

    if (tableConfig.columns.length === 0) continue;

    // Map the source schema to the temp database's schema.
    // MySQL: database IS the schema → use tempDbName.
    // PostgreSQL: schema stays 'public' → use tableConfig.schema as-is.
    const tempSchema = dumpProvider.getTempSchema(tableConfig.schema, tempDbName);

    const columns = await tempAdapter.getColumns(tempSchema, tableConfig.table);
    const primaryKey = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);

    maskTables.push({
      schema: tempSchema,
      table: tableConfig.table,
      columns: tableConfig.columns,
      primaryKey,
    });
  }

  return maskTables;
}

/**
 * Execute the full sync pipeline:
 * 1. Check prerequisites (external tools)
 * 2. Dump source database to file
 * 3. Create temp database and restore dump
 * 4. UPDATE-mask PII columns in temp database
 * 5. Atomic swap: temp → target, target → old
 * 6. Cleanup old database (unless --keep-old)
 */
export async function executeSync(
  config: ShinobiConfig,
  registry: StrategyRegistry,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const dbType = config.source.type;
  if (config.source.type !== config.target.type) {
    throw new ShinobiError(
      `Source (${config.source.type}) and target (${config.target.type}) must be the same database type`,
      'TYPE_MISMATCH',
    );
  }

  const dumpProvider = createDumpRestoreProvider(dbType, config.source.database);
  const swapProvider = createSwapProvider(dbType);

  const targetDb = config.target.database!;
  const tempDbName = generateTempDbName(targetDb);
  const oldDbName = generateOldDbName(targetDb);
  const batchSize = options.batchSize ?? config.options.batchSize;
  const concurrency = options.concurrency ?? 1;
  const deterministic = options.deterministic ?? config.options.deterministic;
  const seed = options.seed ?? config.options.seed;

  // Determine dump file path
  const dumpExt = dbType === 'mongodb' ? '.archive.gz' : '.sql';
  const dumpPath =
    options.inputDump ?? options.keepDump ?? join(tmpdir(), `shinobidb_${tempDbName}${dumpExt}`);
  const shouldDump = !options.inputDump;
  const shouldCleanDump = !options.keepDump && !options.inputDump;

  let tempAdapter: DatabaseAdapter | null = null;

  try {
    // Phase 1: Prerequisites
    options.onProgress?.({ phase: 'dump', message: 'Checking prerequisites...' });
    await dumpProvider.assertToolsAvailable();

    // Log ignored v1 options
    if (config.tables.some((t) => t.copyOnly)) {
      logger.info('Note: copyOnly is ignored in sync mode — all tables are copied via native dump');
    }
    if (config.tables.some((t) => t.incremental)) {
      logger.info('Note: incremental is ignored in sync mode — sync always performs a full copy');
    }

    // Phase 2: Dump
    if (shouldDump) {
      options.onProgress?.({ phase: 'dump', message: `Dumping ${config.source.database}...` });
      logger.info(`Dumping source database: ${config.source.database}`);
      await dumpProvider.dump(config.source, dumpPath);
      logger.success(`Dump complete: ${dumpPath}`);
    } else {
      logger.info(`Using existing dump: ${options.inputDump}`);
    }

    if (options.keepDump && shouldDump) {
      logger.info(`Dump saved to: ${options.keepDump}`);
    }

    // Phase 3: Restore to temp database
    options.onProgress?.({ phase: 'restore', message: `Restoring to ${tempDbName}...` });
    logger.info(`Creating temp database: ${tempDbName}`);
    await dumpProvider.createDatabase(config.target, tempDbName);

    logger.info(`Restoring dump to ${tempDbName}`);
    await dumpProvider.restore(config.target, tempDbName, dumpPath);
    logger.success('Restore complete');

    // Phase 4: UPDATE masking
    options.onProgress?.({ phase: 'mask', message: 'Starting UPDATE masking...' });

    // Connect to temp database
    const tempConfig = { ...config.target, database: tempDbName };
    tempAdapter = createAdapter(tempConfig);
    await tempAdapter.connect();

    const maskTables = await resolveMaskTables(config, tempAdapter, tempDbName, dumpProvider);
    let maskResultRows = 0;
    let maskResultDetails: SyncResult['tableDetails'] = [];

    if (maskTables.length === 0) {
      logger.info('No tables to mask (all tables are copyOnly or have no PII columns)');
    } else {
      logger.info(`Masking ${maskTables.length} table(s) in ${tempDbName}`);
      const maskResult = await executeUpdateMask(tempAdapter, maskTables, registry, {
        batchSize,
        concurrency,
        deterministic,
        seed,
        onProgress: options.onProgress,
      });
      maskResultRows = maskResult.rowsMasked;
      maskResultDetails = maskResult.tableDetails;
      logger.success(
        `Masking complete: ${maskResult.rowsMasked} row(s) in ${maskResult.tablesMasked} table(s)`,
      );

      if (options.dryRun) {
        // Disconnect from temp before returning — prevents leaked connections
        await tempAdapter.destroy();
        tempAdapter = null;

        logger.info('Dry run: skipping swap. Temp database preserved for inspection.');
        let inspectCmd: string;
        if (dbType === 'postgres') {
          inspectCmd = `psql -h ${config.target.host} -p ${config.target.port} -U ${config.target.user} ${tempDbName}`;
        } else if (dbType === 'mongodb') {
          inspectCmd = `mongosh "mongodb://${config.target.host}:${config.target.port}/${tempDbName}"`;
        } else {
          inspectCmd = `mysql -h ${config.target.host} -P ${config.target.port} ${tempDbName}`;
        }
        logger.info(`Inspect with: ${inspectCmd}`);

        return {
          tempDbName,
          tablesMasked: maskResult.tablesMasked,
          rowsMasked: maskResult.rowsMasked,
          tableDetails: maskResult.tableDetails,
          dumpPath: options.keepDump ?? undefined,
          dryRun: true,
        };
      }
    }

    // Disconnect from temp before swap
    await tempAdapter.destroy();
    tempAdapter = null;

    // Phase 5: Atomic swap
    options.onProgress?.({
      phase: 'swap',
      message: `Swapping ${tempDbName} → ${targetDb}...`,
    });
    logger.info(`Swapping: ${tempDbName} → ${targetDb} (old → ${oldDbName})`);
    await swapProvider.swap(config.target, targetDb, tempDbName, oldDbName);
    logger.success('Swap complete');

    // Phase 6: Cleanup
    if (!options.keepOld) {
      options.onProgress?.({ phase: 'cleanup', message: 'Cleaning up...' });
      logger.info(`Dropping old database: ${oldDbName}`);
      await dumpProvider.dropDatabase(config.target, oldDbName);

      // Drop empty temp database (tables were moved out by swap)
      await dumpProvider.dropDatabase(config.target, tempDbName);
      logger.success('Cleanup complete');
    } else {
      logger.info(`Old database preserved: ${oldDbName}`);
    }

    return {
      tempDbName,
      tablesMasked: maskTables.length,
      rowsMasked: maskResultRows,
      tableDetails: maskResultDetails,
      dumpPath: options.keepDump ?? undefined,
      dryRun: false,
    };
  } catch (error) {
    // Cleanup temp database on failure
    if (tempAdapter) {
      await tempAdapter.destroy().catch(() => {});
    }
    try {
      const exists = await dumpProvider.databaseExists(config.target, tempDbName);
      if (exists) {
        logger.warn(`Cleaning up temp database after failure: ${tempDbName}`);
        await dumpProvider.dropDatabase(config.target, tempDbName);
      }
    } catch {
      logger.warn(
        `Failed to clean up temp database: ${tempDbName}. Manual cleanup may be required.`,
      );
    }
    throw error;
  } finally {
    // Clean up temp dump file
    if (shouldCleanDump) {
      const { unlink } = await import('node:fs/promises');
      await unlink(dumpPath).catch(() => {});
    }
  }
}
