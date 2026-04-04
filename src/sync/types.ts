import type { StrategyRegistry } from '../masking/strategy-registry.js';
import type { DatabaseConnectionConfig } from '../shared/types.js';

export interface DumpRestoreProvider {
  /** Verify external tools (mysqldump, pg_dump, etc.) are available */
  assertToolsAvailable(): Promise<void>;

  /** Create an empty database/schema for the temp target */
  createDatabase(config: DatabaseConnectionConfig, dbName: string): Promise<void>;

  /** Dump source database to a file */
  dump(source: DatabaseConnectionConfig, outputPath: string): Promise<void>;

  /** Restore a dump file into the target database */
  restore(target: DatabaseConnectionConfig, targetDbName: string, inputPath: string): Promise<void>;

  /** Drop a database */
  dropDatabase(config: DatabaseConnectionConfig, dbName: string): Promise<void>;

  /** Check if a database exists */
  databaseExists(config: DatabaseConnectionConfig, dbName: string): Promise<boolean>;

  /**
   * Map source schema name to the equivalent schema name in the temp database.
   * MySQL: database IS the schema, so returns tempDbName.
   * PostgreSQL: schema is 'public' within the temp database, so returns sourceSchema as-is.
   */
  getTempSchema(sourceSchema: string, tempDbName: string): string;
}

export interface SwapProvider {
  /**
   * Atomic swap: move tempDb → targetDb, move old targetDb → oldDb.
   * For MySQL: RENAME TABLE across databases (handles tables + views).
   * For PostgreSQL: ALTER SCHEMA RENAME.
   * For MongoDB: renameCollection per collection.
   */
  swap(
    config: DatabaseConnectionConfig,
    targetDb: string,
    tempDb: string,
    oldDb: string,
  ): Promise<void>;
}

export interface SyncProgress {
  phase: 'dump' | 'restore' | 'mask' | 'swap' | 'cleanup';
  message: string;
  /** For mask phase: row-level progress */
  totalRows?: number;
  processedRows?: number;
  currentTable?: string;
  tablesTotal?: number;
  tablesCompleted?: number;
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

export interface SyncOptions {
  dryRun?: boolean;
  keepOld?: boolean;
  keepDump?: string;
  inputDump?: string;
  batchSize?: number;
  concurrency?: number;
  deterministic?: boolean;
  seed?: string;
  onProgress?: SyncProgressCallback;
}

export interface SyncTableResult {
  schema: string;
  table: string;
  rowsMasked: number;
  maskedColumns: string[];
}

export interface SyncResult {
  tempDbName: string;
  tablesMasked: number;
  rowsMasked: number;
  tableDetails: SyncTableResult[];
  dumpPath?: string;
  dryRun: boolean;
}

/** Configuration needed for the sync pipeline (extracted from ShinobiConfig) */
export interface SyncPipelineConfig {
  source: DatabaseConnectionConfig;
  target: DatabaseConnectionConfig;
  tables: SyncMaskTable[];
  options: SyncOptions;
  customStrategies?: string[];
  registry: StrategyRegistry;
}

export interface SyncMaskTable {
  schema: string;
  table: string;
  columns: Array<{
    name: string;
    strategy: string;
    params?: Record<string, unknown>;
  }>;
  primaryKey: string[];
}
