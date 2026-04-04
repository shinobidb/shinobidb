import { MongoClient, type Db } from 'mongodb';

import { generateConfig, configToYaml } from '../../core/config-generator.js';
import { loadConfigFromString } from '../../core/config-loader.js';
import { scan } from '../../core/scanner.js';
import { createAdapter } from '../../db/factory.js';
import { createDefaultDetectors } from '../../detection/detector-factory.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';
import { executeSync } from '../../sync/pipeline.js';
import { isShinobiTempDb } from '../../sync/temp-db.js';

import {
  MONGO_SOURCE_CONFIG,
  MONGO_TARGET_CONFIG,
  waitForMongo,
  createMongoClient,
  getMongoRows,
} from './mongo-helpers.js';

function buildUrl(config: { host: string; port: number; user: string; password: string }): string {
  return `mongodb://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}?authSource=admin`;
}

/** List all databases on a MongoDB server */
async function listDatabases(config: {
  host: string;
  port: number;
  user: string;
  password: string;
}): Promise<string[]> {
  const client = new MongoClient(buildUrl(config));
  await client.connect();
  try {
    const result = await client.db('admin').admin().listDatabases();
    return result.databases.map((d) => d.name);
  } finally {
    await client.close();
  }
}

/** Drop all shinobidb temp databases on a server */
async function cleanupTempDatabases(config: {
  host: string;
  port: number;
  user: string;
  password: string;
}): Promise<void> {
  const client = new MongoClient(buildUrl(config));
  await client.connect();
  try {
    const dbs = await listDatabases(config);
    for (const db of dbs) {
      if (isShinobiTempDb(db)) {
        await client.db(db).dropDatabase();
      }
    }
    // Also clean up old databases
    for (const db of dbs) {
      if (db.includes('_shinobi_old_')) {
        await client.db(db).dropDatabase();
      }
    }
  } finally {
    await client.close();
  }
}

/** Check if a database exists */
async function databaseExists(
  config: { host: string; port: number; user: string; password: string },
  dbName: string,
): Promise<boolean> {
  const dbs = await listDatabases(config);
  return dbs.includes(dbName);
}

describe('E2E: sync pipeline (MongoDB)', () => {
  let sourceClient: MongoClient;
  let targetClient: MongoClient;
  let sourceDb: Db;
  let targetDb: Db;

  beforeAll(async () => {
    await Promise.all([waitForMongo(MONGO_SOURCE_CONFIG), waitForMongo(MONGO_TARGET_CONFIG)]);
  }, 60_000);

  afterAll(async () => {
    await cleanupTempDatabases(MONGO_TARGET_CONFIG);
  }, 30_000);

  beforeEach(async () => {
    // Recreate source_db with test data
    const setupSourceClient = createMongoClient(MONGO_SOURCE_CONFIG);
    await setupSourceClient.connect();
    try {
      const db = setupSourceClient.db('source_db');
      // Drop all collections
      const collections = await db.listCollections().toArray();
      for (const col of collections) {
        await db.dropCollection(col.name);
      }

      // Create users collection with test data
      await db.collection('users').insertMany([
        {
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Johnson',
          phone: '+1-555-123-4567',
          created_at: new Date('2024-01-15T10:30:00Z'),
        },
        {
          email: 'bob@company.org',
          first_name: 'Bob',
          last_name: 'Smith',
          phone: '+1-555-987-6543',
          created_at: new Date('2024-02-20T14:00:00Z'),
        },
        {
          email: 'charlie@test.io',
          first_name: 'Charlie',
          last_name: 'Brown',
          phone: '+1-555-456-7890',
          created_at: new Date('2024-03-10T08:15:00Z'),
        },
      ]);

      // Non-PII collection (should be copied but not masked)
      await db.collection('settings').insertMany([
        { setting_key: 'theme', setting_value: 'dark' },
        { setting_key: 'locale', setting_value: 'ja_JP' },
      ]);
    } finally {
      await setupSourceClient.close();
    }

    // Ensure target_db exists with some existing data (to test swap)
    const setupTargetClient = createMongoClient(MONGO_TARGET_CONFIG);
    await setupTargetClient.connect();
    try {
      const db = setupTargetClient.db('target_db');
      const collections = await db.listCollections().toArray();
      for (const col of collections) {
        await db.dropCollection(col.name);
      }

      await db.collection('users').insertMany([
        {
          email: 'old@stale.com',
          first_name: 'Old',
          last_name: 'Data',
          phone: '+0-000-000-0000',
        },
      ]);
    } finally {
      await setupTargetClient.close();
    }

    // Clean up any leftover temp databases on target
    await cleanupTempDatabases(MONGO_TARGET_CONFIG);

    // Create fresh clients
    sourceClient = createMongoClient(MONGO_SOURCE_CONFIG);
    await sourceClient.connect();
    sourceDb = sourceClient.db('source_db');

    targetClient = createMongoClient(MONGO_TARGET_CONFIG);
    await targetClient.connect();
    targetDb = targetClient.db('target_db');
  });

  afterEach(async () => {
    await cleanupTempDatabases(MONGO_TARGET_CONFIG);
    await sourceClient.close();
    await targetClient.close();
  });

  async function buildSyncConfig() {
    const adapter = createAdapter({ type: 'mongodb', ...MONGO_SOURCE_CONFIG });
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const scanResult = await scan(adapter, detectors, { schemas: ['source_db'] });
      const config = generateConfig(scanResult, {
        source: { type: 'mongodb', ...MONGO_SOURCE_CONFIG },
        target: { type: 'mongodb', ...MONGO_TARGET_CONFIG },
      });
      const yaml = configToYaml(config);
      const loaded = loadConfigFromString(yaml);
      loaded.source.password = MONGO_SOURCE_CONFIG.password;
      loaded.target.password = MONGO_TARGET_CONFIG.password;
      return loaded;
    } finally {
      await adapter.destroy();
    }
  }

  it('should execute full sync: dump → restore → mask → swap → cleanup', async () => {
    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    const result = await executeSync(config, registry, {
      concurrency: 1,
    });

    // Verify result
    expect(result.dryRun).toBe(false);
    expect(result.tablesMasked).toBeGreaterThanOrEqual(1);
    expect(result.rowsMasked).toBe(3); // 3 users

    // Reconnect to target (it was swapped)
    await targetClient.close();
    targetClient = createMongoClient(MONGO_TARGET_CONFIG);
    await targetClient.connect();
    targetDb = targetClient.db('target_db');

    // Verify target_db has been replaced
    const targetRows = await getMongoRows(targetDb, 'users');
    expect(targetRows).toHaveLength(3);

    // PII should be masked
    const sourceRows = await getMongoRows(sourceDb, 'users');
    expect(targetRows[0]!['email']).not.toBe(sourceRows[0]!['email']);
    expect(targetRows[0]!['first_name']).not.toBe(sourceRows[0]!['first_name']);

    // Non-PII collection should be copied as-is
    const settingsRows = await getMongoRows(targetDb, 'settings');
    expect(settingsRows).toHaveLength(2);
    expect(settingsRows[0]!['setting_key']).toBe('theme');

    // created_at should be preserved
    expect(targetRows[0]!['created_at']).toEqual(sourceRows[0]!['created_at']);

    // Temp databases should be cleaned up
    const dbs = await listDatabases(MONGO_TARGET_CONFIG);
    const tempDbs = dbs.filter(isShinobiTempDb);
    expect(tempDbs).toHaveLength(0);
  });

  it('should preserve temp DB in dry-run mode', async () => {
    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    const result = await executeSync(config, registry, {
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.rowsMasked).toBe(3);

    // Temp database should still exist
    const exists = await databaseExists(MONGO_TARGET_CONFIG, result.tempDbName);
    expect(exists).toBe(true);

    // Original target should be unchanged (no swap happened)
    const targetRows = await getMongoRows(targetDb, 'users');
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]!['email']).toBe('old@stale.com');

    // Temp DB should have masked data
    const tempClient = createMongoClient(MONGO_TARGET_CONFIG);
    await tempClient.connect();
    try {
      const tempDb = tempClient.db(result.tempDbName);
      const tempRows = await getMongoRows(tempDb, 'users');
      expect(tempRows).toHaveLength(3);
      // Masked — different from source
      const sourceRows = await getMongoRows(sourceDb, 'users');
      expect(tempRows[0]!['email']).not.toBe(sourceRows[0]!['email']);
    } finally {
      await tempClient.close();
    }
  });

  it('should keep old DB when --keep-old is set', async () => {
    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    const result = await executeSync(config, registry, {
      keepOld: true,
    });

    expect(result.dryRun).toBe(false);

    // Reconnect to target (swapped)
    await targetClient.close();
    targetClient = createMongoClient(MONGO_TARGET_CONFIG);
    await targetClient.connect();
    targetDb = targetClient.db('target_db');

    // An old database should exist
    const dbs = await listDatabases(MONGO_TARGET_CONFIG);
    const oldDbs = dbs.filter((db) => db.includes('_shinobi_old_'));
    expect(oldDbs).toHaveLength(1);

    // Old DB should contain the previous target data
    const oldClient = createMongoClient(MONGO_TARGET_CONFIG);
    await oldClient.connect();
    try {
      const oldDb = oldClient.db(oldDbs[0]!);
      const oldRows = await getMongoRows(oldDb, 'users');
      expect(oldRows).toHaveLength(1);
      expect(oldRows[0]!['email']).toBe('old@stale.com');
    } finally {
      await oldClient.close();
    }

    // New target should have masked source data
    const targetRows = await getMongoRows(targetDb, 'users');
    expect(targetRows).toHaveLength(3);
  });

  it('should produce deterministic results with same seed', async () => {
    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    // Run 1
    await executeSync(config, registry, { deterministic: true, seed: 'e2e-seed' });

    // Read results from run 1
    await targetClient.close();
    targetClient = createMongoClient(MONGO_TARGET_CONFIG);
    await targetClient.connect();
    const rows1 = await getMongoRows(targetClient.db('target_db'), 'users');

    // Reset target for run 2
    await targetClient.close();
    const resetClient = createMongoClient(MONGO_TARGET_CONFIG);
    await resetClient.connect();
    try {
      const db = resetClient.db('target_db');
      const collections = await db.listCollections().toArray();
      for (const col of collections) {
        await db.dropCollection(col.name);
      }
      await db.collection('users').insertOne({
        email: 'placeholder@test.com',
        first_name: 'Placeholder',
        last_name: 'Data',
        phone: '+0-000-000-0000',
      });
    } finally {
      await resetClient.close();
    }

    await cleanupTempDatabases(MONGO_TARGET_CONFIG);

    // Run 2
    await executeSync(config, registry, { deterministic: true, seed: 'e2e-seed' });

    targetClient = createMongoClient(MONGO_TARGET_CONFIG);
    await targetClient.connect();
    const rows2 = await getMongoRows(targetClient.db('target_db'), 'users');

    // Same seed → same masked values
    expect(rows1[0]!['email']).toBe(rows2[0]!['email']);
    expect(rows1[0]!['first_name']).toBe(rows2[0]!['first_name']);
    expect(rows1[1]!['email']).toBe(rows2[1]!['email']);
  });

  it('should handle collections without _id index gracefully', async () => {
    // MongoDB always has _id as primary key, so the "no PK" scenario
    // from MySQL/PG doesn't apply. Instead, verify that collections
    // with only system indexes work correctly.
    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    const result = await executeSync(config, registry);
    expect(result.dryRun).toBe(false);
    expect(result.rowsMasked).toBe(3);
  });
});
