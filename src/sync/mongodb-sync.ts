import { MongoClient } from 'mongodb';

import { ShinobiError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import type { DatabaseConnectionConfig } from '../shared/types.js';

import { commandExists, spawnAndWait } from './spawn-utils.js';
import type { DumpRestoreProvider, SwapProvider } from './types.js';

function buildMongoUri(config: DatabaseConnectionConfig, dbName?: string): string {
  const user = encodeURIComponent(config.user);
  const pass = encodeURIComponent(config.password);
  const db = dbName ?? config.database ?? '';
  return `mongodb://${user}:${pass}@${config.host}:${config.port}/${db}?authSource=admin`;
}

/** Build URI without database — needed for mongorestore with --nsFrom/--nsTo */
function buildMongoUriNoDB(config: DatabaseConnectionConfig): string {
  const user = encodeURIComponent(config.user);
  const pass = encodeURIComponent(config.password);
  return `mongodb://${user}:${pass}@${config.host}:${config.port}/?authSource=admin`;
}

export class MongoDumpRestore implements DumpRestoreProvider {
  private sourceDbName: string | null = null;

  constructor(sourceDbName?: string) {
    this.sourceDbName = sourceDbName ?? null;
  }

  async assertToolsAvailable(): Promise<void> {
    const [hasDump, hasRestore] = await Promise.all([
      commandExists('mongodump'),
      commandExists('mongorestore'),
    ]);

    const missing: string[] = [];
    if (!hasDump) missing.push('mongodump');
    if (!hasRestore) missing.push('mongorestore');

    if (missing.length > 0) {
      throw new ShinobiError(
        `Required tools not found: ${missing.join(', ')}. ` +
          'Install MongoDB Database Tools: ' +
          'macOS: brew install mongodb-database-tools | ' +
          'Ubuntu/Debian: apt-get install mongodb-database-tools | ' +
          'Docker: install from https://www.mongodb.com/try/download/database-tools',
        'MISSING_TOOLS',
      );
    }
  }

  async createDatabase(config: DatabaseConnectionConfig, dbName: string): Promise<void> {
    // MongoDB creates databases lazily on first write.
    // Create an init collection to materialize the database, then drop it.
    const client = new MongoClient(buildMongoUri(config));
    try {
      await client.connect();
      const db = client.db(dbName);
      await db.createCollection('_shinobidb_init');
      await db.dropCollection('_shinobidb_init');
      logger.debug(`Created database: ${dbName}`);
    } finally {
      await client.close();
    }
  }

  async dump(source: DatabaseConnectionConfig, outputPath: string): Promise<void> {
    this.sourceDbName = source.database!;
    const args = [
      `--uri=${buildMongoUri(source, source.database!)}`,
      `--archive=${outputPath}`,
      '--gzip',
    ];

    const result = await spawnAndWait('mongodump', args);

    if (result.exitCode !== 0) {
      const { unlink } = await import('node:fs/promises');
      await unlink(outputPath).catch(() => {});
      throw new ShinobiError(
        `mongodump failed (exit code ${result.exitCode}): ${result.stderr.trim()}`,
        'DUMP_FAILED',
      );
    }

    logger.debug(`Dump written to ${outputPath}`);
  }

  async restore(
    target: DatabaseConnectionConfig,
    targetDbName: string,
    inputPath: string,
  ): Promise<void> {
    // URI must NOT include a database when using --nsFrom/--nsTo,
    // otherwise mongorestore ignores the namespace remapping.
    const args = [
      `--uri=${buildMongoUriNoDB(target)}`,
      `--archive=${inputPath}`,
      '--gzip',
      // Remap the source database namespace to the target database.
      // sourceDbName is set during dump(), or passed via constructor for inputDump.
      `--nsFrom=${this.sourceDbName ?? target.database!}.*`,
      `--nsTo=${targetDbName}.*`,
      '--drop',
    ];

    const result = await spawnAndWait('mongorestore', args);

    if (result.exitCode !== 0) {
      throw new ShinobiError(
        `mongorestore failed (exit code ${result.exitCode}): ${result.stderr.trim()}`,
        'RESTORE_FAILED',
      );
    }

    logger.debug(`Restored dump to ${targetDbName}`);
  }

  async dropDatabase(config: DatabaseConnectionConfig, dbName: string): Promise<void> {
    const client = new MongoClient(buildMongoUri(config));
    try {
      await client.connect();
      await client.db(dbName).dropDatabase();
      logger.debug(`Dropped database: ${dbName}`);
    } finally {
      await client.close();
    }
  }

  async databaseExists(config: DatabaseConnectionConfig, dbName: string): Promise<boolean> {
    const client = new MongoClient(buildMongoUri(config));
    try {
      await client.connect();
      const dbs = await client.db('admin').admin().listDatabases();
      return dbs.databases.some((d) => d.name === dbName);
    } finally {
      await client.close();
    }
  }

  getTempSchema(_sourceSchema: string, tempDbName: string): string {
    // MongoDB has no schema concept — database name serves as the namespace
    return tempDbName;
  }
}

export class MongoSwap implements SwapProvider {
  /**
   * Swap databases by renaming collections one by one.
   *
   * Unlike MySQL (atomic RENAME TABLE) or PostgreSQL (ALTER DATABASE RENAME),
   * MongoDB does not support atomic database rename. Collections are moved
   * individually via the admin renameCollection command.
   *
   * Steps:
   * 1. Create oldDb
   * 2. Move targetDb collections → oldDb
   * 3. Move tempDb collections → targetDb
   */
  async swap(
    config: DatabaseConnectionConfig,
    targetDb: string,
    tempDb: string,
    oldDb: string,
  ): Promise<void> {
    logger.warn(
      'MongoDB swap is NOT atomic — collections are renamed one by one. ' +
        'If the process is interrupted mid-swap, manual recovery may be required.',
    );

    const client = new MongoClient(buildMongoUri(config));
    try {
      await client.connect();
      const adminDb = client.db('admin');

      // List collections in target (to move to old)
      const targetCollections = await client
        .db(targetDb)
        .listCollections({ type: 'collection' })
        .toArray();

      // List collections in temp (to move to target)
      const tempCollections = await client
        .db(tempDb)
        .listCollections({ type: 'collection' })
        .toArray();

      if (tempCollections.length === 0) {
        throw new ShinobiError(
          `Temp database "${tempDb}" has no collections. Dump/restore may have failed.`,
          'SWAP_FAILED',
        );
      }

      // Move target → old
      for (const col of targetCollections) {
        await adminDb.command({
          renameCollection: `${targetDb}.${col.name}`,
          to: `${oldDb}.${col.name}`,
        });
      }

      // Move temp → target
      for (const col of tempCollections) {
        await adminDb.command({
          renameCollection: `${tempDb}.${col.name}`,
          to: `${targetDb}.${col.name}`,
        });
      }

      logger.debug(`Swapped: ${tempDb} → ${targetDb}, old → ${oldDb}`);
    } finally {
      await client.close();
    }
  }
}
