import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import mysql from 'mysql2/promise';

import type { ShinobiConfig } from '../../config/types.js';
import { executeMask } from '../../core/mask-executor.js';
import { createAdapter } from '../../db/factory.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';
import { ShinobiError } from '../../shared/errors.js';

import { SOURCE_CONFIG, TARGET_CONFIG, waitForMySQL, getRows, cleanupDatabase } from './helpers.js';
import {
  createTempDir,
  readSyncState,
  buildIncrementalConfig,
  type TempDirHandle,
} from './incremental-helpers.js';

describe('E2E MySQL: incremental sync', () => {
  let sourcePool: mysql.Pool;
  let targetPool: mysql.Pool;

  beforeAll(async () => {
    await Promise.all([waitForMySQL(SOURCE_CONFIG), waitForMySQL(TARGET_CONFIG)]);
    sourcePool = mysql.createPool(SOURCE_CONFIG);
    targetPool = mysql.createPool(TARGET_CONFIG);
  }, 60_000);

  afterAll(async () => {
    await sourcePool.end();
    await targetPool.end();
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
      await cleanupDatabase(sourcePool);
      await cleanupDatabase(targetPool);

      await sourcePool.query(`
        CREATE TABLE users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          first_name VARCHAR(100) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
        )
      `);
      await targetPool.query(`
        CREATE TABLE users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          first_name VARCHAR(100) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
        )
      `);
    });

    afterAll(async () => {
      await cleanupDatabase(sourcePool);
      await cleanupDatabase(targetPool);
      await tempDir.cleanup();
    });

    const config = () =>
      buildIncrementalConfig(
        { type: 'mysql', ...SOURCE_CONFIG },
        { type: 'mysql', ...TARGET_CONFIG },
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
      await sourcePool.query(`
        INSERT INTO users (email, first_name, created_at) VALUES
        ('alice@example.com', 'Alice', '2026-01-01 00:00:01'),
        ('bob@example.com', 'Bob', '2026-01-01 00:00:02')
      `);

      const result = await runMask(config(), tempDir.path);
      expect(result.rowsProcessed).toBe(2);
      expect(result.rowsWritten).toBe(2);

      const targetRows = await getRows(targetPool, 'users');
      expect(targetRows).toHaveLength(2);
      expect(targetRows[0]!['email']).not.toBe('alice@example.com');
      expect(targetRows[0]!['email'] as string).toContain('@example.com');

      const state = await readSyncState(tempDir.path);
      expect(state).not.toBeNull();
      expect((state!['tables'] as Record<string, unknown>)['source_db.users']).toBeDefined();
    });

    it('A2: second sync picks up only new rows', async () => {
      await sourcePool.query(`
        INSERT INTO users (email, first_name, created_at) VALUES
        ('charlie@example.com', 'Charlie', '2026-01-01 00:00:03')
      `);

      const result = await runMask(config(), tempDir.path);
      expect(result.rowsProcessed).toBe(1);

      const targetRows = await getRows(targetPool, 'users');
      expect(targetRows).toHaveLength(3);
    });

    it('A3: sync with no new rows processes zero rows', async () => {
      const result = await runMask(config(), tempDir.path);
      expect(result.rowsProcessed).toBe(0);

      const targetRows = await getRows(targetPool, 'users');
      expect(targetRows).toHaveLength(3);
    });

    it('A4: --full-refresh re-processes all rows', async () => {
      const result = await runMask(config(), tempDir.path, true);
      expect(result.rowsProcessed).toBe(3);

      const targetRows = await getRows(targetPool, 'users');
      expect(targetRows).toHaveLength(3);
    });
  });

  describe('Scenario B: cursor-based incremental with masking', () => {
    let tempDir: TempDirHandle;

    beforeAll(async () => {
      tempDir = await createTempDir();
      await cleanupDatabase(sourcePool);
      await cleanupDatabase(targetPool);

      await sourcePool.query(`
        CREATE TABLE orders (
          id INT AUTO_INCREMENT PRIMARY KEY,
          customer_email VARCHAR(255) NOT NULL,
          amount DECIMAL(10, 2) NOT NULL
        )
      `);
      await targetPool.query(`
        CREATE TABLE orders (
          id INT AUTO_INCREMENT PRIMARY KEY,
          customer_email VARCHAR(255) NOT NULL,
          amount DECIMAL(10, 2) NOT NULL
        )
      `);
    });

    afterAll(async () => {
      await sourcePool.query('DROP TABLE IF EXISTS orders');
      await targetPool.query('DROP TABLE IF EXISTS orders');
      await tempDir.cleanup();
    });

    it('B1: cursor-based sync on auto-increment PK', async () => {
      await sourcePool.query(`
        INSERT INTO orders (customer_email, amount) VALUES
        ('alice@example.com', 100.00),
        ('bob@example.com', 200.00)
      `);

      const cfg = buildIncrementalConfig(
        { type: 'mysql', ...SOURCE_CONFIG },
        { type: 'mysql', ...TARGET_CONFIG },
        [
          {
            schema: 'source_db',
            table: 'orders',
            columns: [{ name: 'customer_email', strategy: 'hash_email' }],
            incremental: { strategy: 'cursor', column: 'id' },
          },
        ],
      );

      const result1 = await runMask(cfg, tempDir.path);
      expect(result1.rowsProcessed).toBe(2);

      await sourcePool.query(`
        INSERT INTO orders (customer_email, amount) VALUES
        ('charlie@example.com', 300.00)
      `);

      const result2 = await runMask(cfg, tempDir.path);
      expect(result2.rowsProcessed).toBe(1);

      const targetRows = await getRows(targetPool, 'orders');
      expect(targetRows).toHaveLength(3);
      expect(targetRows[2]!['customer_email']).not.toBe('charlie@example.com');
    });
  });

  describe('Scenario C: copyOnly incremental', () => {
    let tempDir: TempDirHandle;

    beforeAll(async () => {
      tempDir = await createTempDir();
      await cleanupDatabase(sourcePool);
      await cleanupDatabase(targetPool);

      await sourcePool.query(`
        CREATE TABLE logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          message TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
        )
      `);
      await targetPool.query(`
        CREATE TABLE logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          message TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
        )
      `);
    });

    afterAll(async () => {
      await sourcePool.query('DROP TABLE IF EXISTS logs');
      await targetPool.query('DROP TABLE IF EXISTS logs');
      await tempDir.cleanup();
    });

    it('C1: copyOnly incremental copies without masking and supports upsert', async () => {
      await sourcePool.query(`
        INSERT INTO logs (message, created_at) VALUES
        ('log entry 1', '2026-01-01 00:00:01'),
        ('log entry 2', '2026-01-01 00:00:02')
      `);

      const cfg = buildIncrementalConfig(
        { type: 'mysql', ...SOURCE_CONFIG },
        { type: 'mysql', ...TARGET_CONFIG },
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

      const targetRows1 = await getRows(targetPool, 'logs');
      expect(targetRows1).toHaveLength(2);
      expect(targetRows1[0]!['message']).toBe('log entry 1');

      // Add more data
      await sourcePool.query(`
        INSERT INTO logs (message, created_at) VALUES
        ('log entry 3', '2026-01-01 00:00:03')
      `);

      const result2 = await runMask(cfg, tempDir.path);
      expect(result2.rowsProcessed).toBe(1);

      const targetRows2 = await getRows(targetPool, 'logs');
      expect(targetRows2).toHaveLength(3);
      expect(targetRows2[2]!['message']).toBe('log entry 3');
    });
  });

  describe('Scenario D: deterministic masking consistency', () => {
    let tempDir: TempDirHandle;

    beforeAll(async () => {
      tempDir = await createTempDir();
      await cleanupDatabase(sourcePool);
      await cleanupDatabase(targetPool);

      await sourcePool.query(`
        CREATE TABLE users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          first_name VARCHAR(100) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
        )
      `);
      await targetPool.query(`
        CREATE TABLE users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          first_name VARCHAR(100) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
        )
      `);
    });

    afterAll(async () => {
      await cleanupDatabase(sourcePool);
      await cleanupDatabase(targetPool);
      await tempDir.cleanup();
    });

    it('D1: same source row produces same masked output across syncs', async () => {
      await sourcePool.query(`
        INSERT INTO users (email, first_name, created_at) VALUES
        ('stable@example.com', 'Stable', '2026-01-01 00:00:01')
      `);

      const cfg = buildIncrementalConfig(
        { type: 'mysql', ...SOURCE_CONFIG },
        { type: 'mysql', ...TARGET_CONFIG },
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
      const rows1 = await getRows(targetPool, 'users');
      const maskedEmail1 = rows1[0]!['email'] as string;

      // Full refresh should produce the same masked value for same PK
      await runMask(cfg, tempDir.path, true);
      const rows2 = await getRows(targetPool, 'users');
      const maskedEmail2 = rows2[0]!['email'] as string;

      expect(maskedEmail1).toBe(maskedEmail2);
    });
  });

  describe('Error scenarios', () => {
    it('E1: corrupted sync state file throws SYNC_STATE_CORRUPTED', async () => {
      const tempDir = await createTempDir();
      try {
        await cleanupDatabase(sourcePool);
        await cleanupDatabase(targetPool);

        await sourcePool.query(`
          CREATE TABLE users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
          )
        `);
        await targetPool.query(`
          CREATE TABLE users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
          )
        `);

        await sourcePool.query(`
          INSERT INTO users (email, created_at) VALUES ('test@example.com', '2026-01-01 00:00:01')
        `);

        // Write corrupted sync state
        const stateDir = join(tempDir.path, '.shinobidb');
        await mkdir(stateDir, { recursive: true });
        await writeFile(join(stateDir, 'sync-state.json'), '{corrupted json!!!', 'utf-8');

        const cfg = buildIncrementalConfig(
          { type: 'mysql', ...SOURCE_CONFIG },
          { type: 'mysql', ...TARGET_CONFIG },
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
        await cleanupDatabase(sourcePool);
        await cleanupDatabase(targetPool);
        await tempDir.cleanup();
      }
    });

    it('E2: table without PK throws INCREMENTAL_NO_PK', async () => {
      const tempDir = await createTempDir();
      try {
        await cleanupDatabase(sourcePool);
        await cleanupDatabase(targetPool);

        await sourcePool.query(`
          CREATE TABLE nopk (
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
          )
        `);
        await targetPool.query(`
          CREATE TABLE nopk (
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
          )
        `);

        const cfg = buildIncrementalConfig(
          { type: 'mysql', ...SOURCE_CONFIG },
          { type: 'mysql', ...TARGET_CONFIG },
          [
            {
              schema: 'source_db',
              table: 'nopk',
              columns: [{ name: 'email', strategy: 'hash_email' }],
              incremental: { strategy: 'timestamp', column: 'created_at' },
            },
          ],
        );

        await expect(runMask(cfg, tempDir.path)).rejects.toThrow('INCREMENTAL_NO_PK');
      } finally {
        await sourcePool.query('DROP TABLE IF EXISTS nopk');
        await targetPool.query('DROP TABLE IF EXISTS nopk');
        await tempDir.cleanup();
      }
    });

    it('E3: target table without PK throws TARGET_NO_PK', async () => {
      const tempDir = await createTempDir();
      try {
        await cleanupDatabase(sourcePool);
        await cleanupDatabase(targetPool);

        await sourcePool.query(`
          CREATE TABLE users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
          )
        `);
        // Target has no PK
        await targetPool.query(`
          CREATE TABLE users (
            id INT NOT NULL,
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT '2026-01-01 00:00:00'
          )
        `);

        const cfg = buildIncrementalConfig(
          { type: 'mysql', ...SOURCE_CONFIG },
          { type: 'mysql', ...TARGET_CONFIG },
          [
            {
              schema: 'source_db',
              table: 'users',
              columns: [{ name: 'email', strategy: 'hash_email' }],
              incremental: { strategy: 'timestamp', column: 'created_at' },
            },
          ],
        );

        await expect(runMask(cfg, tempDir.path)).rejects.toThrow('TARGET_NO_PK');
      } finally {
        await cleanupDatabase(sourcePool);
        await cleanupDatabase(targetPool);
        await tempDir.cleanup();
      }
    });
  });
});
