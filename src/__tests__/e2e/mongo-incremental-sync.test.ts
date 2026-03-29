import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { type Db, MongoClient } from 'mongodb';

import type { ShinobiConfig } from '../../config/types.js';
import { executeMask } from '../../core/mask-executor.js';
import { createAdapter } from '../../db/factory.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';
import { ShinobiError } from '../../shared/errors.js';

import {
  createTempDir,
  readSyncState,
  buildIncrementalConfig,
  type TempDirHandle,
} from './incremental-helpers.js';
import {
  MONGO_SOURCE_CONFIG,
  MONGO_TARGET_CONFIG,
  waitForMongo,
  createMongoClient,
  cleanupMongoDatabase,
  getMongoRows,
} from './mongo-helpers.js';

describe('E2E MongoDB: incremental sync', () => {
  let sourceClient: MongoClient;
  let targetClient: MongoClient;
  let sourceDb: Db;
  let targetDb: Db;

  beforeAll(async () => {
    await Promise.all([waitForMongo(MONGO_SOURCE_CONFIG), waitForMongo(MONGO_TARGET_CONFIG)]);
    sourceClient = createMongoClient(MONGO_SOURCE_CONFIG);
    targetClient = createMongoClient(MONGO_TARGET_CONFIG);
    await Promise.all([sourceClient.connect(), targetClient.connect()]);
    sourceDb = sourceClient.db(MONGO_SOURCE_CONFIG.database);
    targetDb = targetClient.db(MONGO_TARGET_CONFIG.database);
  }, 60_000);

  afterAll(async () => {
    await sourceClient.close();
    await targetClient.close();
  });

  async function runMask(config: ShinobiConfig, syncStateDir: string, fullRefresh = false) {
    const source = createAdapter(config.source);
    const target = createAdapter(config.target);
    const registry = createDefaultRegistry();
    try {
      await source.connect();
      await target.connect();
      return await executeMask(source, target, config, registry, { syncStateDir, fullRefresh });
    } finally {
      await Promise.all([source.destroy(), target.destroy()]);
    }
  }

  describe('Scenario A: timestamp-based incremental with masking', () => {
    let tempDir: TempDirHandle;

    beforeAll(async () => {
      tempDir = await createTempDir();
      await cleanupMongoDatabase(sourceDb);
      await cleanupMongoDatabase(targetDb);
      // Pre-create target collection so it exists
      await targetDb.createCollection('users');
    });

    afterAll(async () => {
      await cleanupMongoDatabase(sourceDb);
      await cleanupMongoDatabase(targetDb);
      await tempDir.cleanup();
    });

    const config = () =>
      buildIncrementalConfig(
        { type: 'mongodb', ...MONGO_SOURCE_CONFIG },
        { type: 'mongodb', ...MONGO_TARGET_CONFIG },
        [
          {
            schema: 'source_db',
            table: 'users',
            columns: [{ name: 'email', strategy: 'hash_email' }],
            incremental: { strategy: 'timestamp', column: 'created_at' },
          },
        ],
      );

    it('A1: initial sync processes all rows and creates sync state', async () => {
      await sourceDb.collection('users').insertMany([
        {
          email: 'alice@example.com',
          first_name: 'Alice',
          created_at: new Date('2026-01-01T00:00:01Z'),
        },
        {
          email: 'bob@example.com',
          first_name: 'Bob',
          created_at: new Date('2026-01-01T00:00:02Z'),
        },
      ]);

      const result = await runMask(config(), tempDir.path);
      expect(result.rowsProcessed).toBe(2);
      expect(result.rowsWritten).toBe(2);

      const targetRows = await getMongoRows(targetDb, 'users');
      expect(targetRows).toHaveLength(2);
      expect(targetRows[0]!['email']).not.toBe('alice@example.com');
      expect(targetRows[0]!['email'] as string).toContain('@example.com');

      const state = await readSyncState(tempDir.path);
      expect(state).not.toBeNull();
      expect((state!['tables'] as Record<string, unknown>)['source_db.users']).toBeDefined();
    });

    it('A2: second sync picks up only new rows', async () => {
      await sourceDb.collection('users').insertOne({
        email: 'charlie@example.com',
        first_name: 'Charlie',
        created_at: new Date('2026-01-01T00:00:03Z'),
      });

      const result = await runMask(config(), tempDir.path);
      expect(result.rowsProcessed).toBe(1);

      const targetRows = await getMongoRows(targetDb, 'users');
      expect(targetRows).toHaveLength(3);
    });

    it('A3: sync with no new rows processes zero rows', async () => {
      const result = await runMask(config(), tempDir.path);
      expect(result.rowsProcessed).toBe(0);

      const targetRows = await getMongoRows(targetDb, 'users');
      expect(targetRows).toHaveLength(3);
    });

    it('A4: --full-refresh re-processes all rows', async () => {
      const result = await runMask(config(), tempDir.path, true);
      expect(result.rowsProcessed).toBe(3);

      const targetRows = await getMongoRows(targetDb, 'users');
      expect(targetRows).toHaveLength(3);
    });
  });

  describe('Scenario B: cursor-based incremental with masking', () => {
    let tempDir: TempDirHandle;

    beforeAll(async () => {
      tempDir = await createTempDir();
      await cleanupMongoDatabase(sourceDb);
      await cleanupMongoDatabase(targetDb);
      await targetDb.createCollection('orders');
    });

    afterAll(async () => {
      await cleanupMongoDatabase(sourceDb);
      await cleanupMongoDatabase(targetDb);
      await tempDir.cleanup();
    });

    it('B1: cursor-based sync on numeric field', async () => {
      await sourceDb.collection('orders').insertMany([
        { order_id: 1, customer_email: 'alice@example.com', amount: 100 },
        { order_id: 2, customer_email: 'bob@example.com', amount: 200 },
      ]);

      const cfg = buildIncrementalConfig(
        { type: 'mongodb', ...MONGO_SOURCE_CONFIG },
        { type: 'mongodb', ...MONGO_TARGET_CONFIG },
        [
          {
            schema: 'source_db',
            table: 'orders',
            columns: [{ name: 'customer_email', strategy: 'hash_email' }],
            incremental: { strategy: 'cursor', column: 'order_id' },
          },
        ],
      );

      const result1 = await runMask(cfg, tempDir.path);
      expect(result1.rowsProcessed).toBe(2);

      await sourceDb.collection('orders').insertOne({
        order_id: 3,
        customer_email: 'charlie@example.com',
        amount: 300,
      });

      const result2 = await runMask(cfg, tempDir.path);
      expect(result2.rowsProcessed).toBe(1);

      const targetRows = await getMongoRows(targetDb, 'orders');
      expect(targetRows).toHaveLength(3);
      expect(targetRows[2]!['customer_email']).not.toBe('charlie@example.com');
    });
  });

  describe('Scenario C: copyOnly incremental', () => {
    let tempDir: TempDirHandle;

    beforeAll(async () => {
      tempDir = await createTempDir();
      await cleanupMongoDatabase(sourceDb);
      await cleanupMongoDatabase(targetDb);
      await targetDb.createCollection('logs');
    });

    afterAll(async () => {
      await cleanupMongoDatabase(sourceDb);
      await cleanupMongoDatabase(targetDb);
      await tempDir.cleanup();
    });

    it('C1: copyOnly incremental copies without masking and supports upsert', async () => {
      await sourceDb.collection('logs').insertMany([
        { message: 'log entry 1', created_at: new Date('2026-01-01T00:00:01Z') },
        { message: 'log entry 2', created_at: new Date('2026-01-01T00:00:02Z') },
      ]);

      const cfg = buildIncrementalConfig(
        { type: 'mongodb', ...MONGO_SOURCE_CONFIG },
        { type: 'mongodb', ...MONGO_TARGET_CONFIG },
        [
          {
            schema: 'source_db',
            table: 'logs',
            columns: [],
            copyOnly: true,
            incremental: { strategy: 'timestamp', column: 'created_at' },
          },
        ],
      );

      const result1 = await runMask(cfg, tempDir.path);
      expect(result1.rowsProcessed).toBe(2);

      const targetRows1 = await getMongoRows(targetDb, 'logs');
      expect(targetRows1).toHaveLength(2);
      expect(targetRows1[0]!['message']).toBe('log entry 1');

      await sourceDb.collection('logs').insertOne({
        message: 'log entry 3',
        created_at: new Date('2026-01-01T00:00:03Z'),
      });

      const result2 = await runMask(cfg, tempDir.path);
      expect(result2.rowsProcessed).toBe(1);

      const targetRows2 = await getMongoRows(targetDb, 'logs');
      expect(targetRows2).toHaveLength(3);
      expect(targetRows2[2]!['message']).toBe('log entry 3');
    });
  });

  describe('Scenario D: deterministic masking consistency', () => {
    let tempDir: TempDirHandle;

    beforeAll(async () => {
      tempDir = await createTempDir();
      await cleanupMongoDatabase(sourceDb);
      await cleanupMongoDatabase(targetDb);
      await targetDb.createCollection('users');
    });

    afterAll(async () => {
      await cleanupMongoDatabase(sourceDb);
      await cleanupMongoDatabase(targetDb);
      await tempDir.cleanup();
    });

    it('D1: same source row produces same masked output across syncs', async () => {
      await sourceDb.collection('users').insertOne({
        email: 'stable@example.com',
        first_name: 'Stable',
        created_at: new Date('2026-01-01T00:00:01Z'),
      });

      const cfg = buildIncrementalConfig(
        { type: 'mongodb', ...MONGO_SOURCE_CONFIG },
        { type: 'mongodb', ...MONGO_TARGET_CONFIG },
        [
          {
            schema: 'source_db',
            table: 'users',
            columns: [{ name: 'email', strategy: 'hash_email' }],
            incremental: { strategy: 'timestamp', column: 'created_at' },
          },
        ],
      );

      await runMask(cfg, tempDir.path);
      const rows1 = await getMongoRows(targetDb, 'users');
      const maskedEmail1 = rows1[0]!['email'] as string;

      await runMask(cfg, tempDir.path, true);
      const rows2 = await getMongoRows(targetDb, 'users');
      const maskedEmail2 = rows2[0]!['email'] as string;

      expect(maskedEmail1).toBe(maskedEmail2);
    });
  });

  describe('Error scenarios', () => {
    it('E1: corrupted sync state file throws SYNC_STATE_CORRUPTED', async () => {
      const tempDir = await createTempDir();
      try {
        await cleanupMongoDatabase(sourceDb);
        await cleanupMongoDatabase(targetDb);
        await targetDb.createCollection('users');

        await sourceDb.collection('users').insertOne({
          email: 'test@example.com',
          created_at: new Date('2026-01-01T00:00:01Z'),
        });

        const stateDir = join(tempDir.path, '.shinobidb');
        await mkdir(stateDir, { recursive: true });
        await writeFile(join(stateDir, 'sync-state.json'), '{corrupted json!!!', 'utf-8');

        const cfg = buildIncrementalConfig(
          { type: 'mongodb', ...MONGO_SOURCE_CONFIG },
          { type: 'mongodb', ...MONGO_TARGET_CONFIG },
          [
            {
              schema: 'source_db',
              table: 'users',
              columns: [{ name: 'email', strategy: 'hash_email' }],
              incremental: { strategy: 'timestamp', column: 'created_at' },
            },
          ],
        );

        await expect(runMask(cfg, tempDir.path)).rejects.toThrow(ShinobiError);
        await expect(runMask(cfg, tempDir.path)).rejects.toThrow(/SYNC_STATE_CORRUPTED|corrupted/);
      } finally {
        await cleanupMongoDatabase(sourceDb);
        await cleanupMongoDatabase(targetDb);
        await tempDir.cleanup();
      }
    });
  });
});
