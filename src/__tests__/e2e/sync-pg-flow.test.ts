import pg from 'pg';

import { generateConfig, configToYaml } from '../../core/config-generator.js';
import { loadConfigFromString } from '../../core/config-loader.js';
import { scan } from '../../core/scanner.js';
import { createAdapter } from '../../db/factory.js';
import { createDefaultDetectors } from '../../detection/detector-factory.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';
import { executeSync } from '../../sync/pipeline.js';
import { isShinobiTempDb } from '../../sync/temp-db.js';

import { PG_SOURCE_CONFIG, PG_TARGET_CONFIG, waitForPostgres, getPgRows } from './pg-helpers.js';

/** List all databases on a PostgreSQL server */
async function listDatabases(config: {
  host: string;
  port: number;
  user: string;
  password: string;
}): Promise<string[]> {
  const client = new pg.Client({ ...config, database: 'postgres' });
  await client.connect();
  try {
    const result = await client.query(
      'SELECT datname FROM pg_database WHERE datistemplate = false',
    );
    return result.rows.map((r: Record<string, unknown>) => r['datname'] as string);
  } finally {
    await client.end();
  }
}

/** Drop all shinobidb temp databases on a server */
async function cleanupTempDatabases(config: {
  host: string;
  port: number;
  user: string;
  password: string;
}): Promise<void> {
  const client = new pg.Client({ ...config, database: 'postgres' });
  await client.connect();
  try {
    const dbs = await listDatabases(config);
    for (const db of dbs) {
      if (isShinobiTempDb(db)) {
        // Terminate connections before dropping
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [db],
        );
        await client.query(`DROP DATABASE IF EXISTS "${db}"`);
      }
    }
  } finally {
    await client.end();
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

describe('E2E: sync pipeline (PostgreSQL)', () => {
  let sourcePool: pg.Pool;
  let targetPool: pg.Pool;

  beforeAll(async () => {
    await Promise.all([waitForPostgres(PG_SOURCE_CONFIG), waitForPostgres(PG_TARGET_CONFIG)]);
  }, 60_000);

  afterAll(async () => {
    await cleanupTempDatabases(PG_TARGET_CONFIG);
  }, 30_000);

  beforeEach(async () => {
    // Recreate source_db with test data
    const sourceAdmin = new pg.Client({ ...PG_SOURCE_CONFIG, database: 'postgres' });
    await sourceAdmin.connect();
    try {
      // Terminate existing connections to source_db
      await sourceAdmin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'source_db' AND pid <> pg_backend_pid()`,
      );
      await sourceAdmin.query('DROP DATABASE IF EXISTS source_db');
      await sourceAdmin.query('CREATE DATABASE source_db');
    } finally {
      await sourceAdmin.end();
    }

    const sourceClient = new pg.Client(PG_SOURCE_CONFIG);
    await sourceClient.connect();
    try {
      await sourceClient.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          first_name VARCHAR(100) NOT NULL,
          last_name VARCHAR(100) NOT NULL,
          phone VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await sourceClient.query(`
        INSERT INTO users (email, first_name, last_name, phone) VALUES
        ('alice@example.com', 'Alice', 'Johnson', '+1-555-123-4567'),
        ('bob@company.org', 'Bob', 'Smith', '+1-555-987-6543'),
        ('charlie@test.io', 'Charlie', 'Brown', '+1-555-456-7890')
      `);

      // Non-PII table (should be copied but not masked)
      await sourceClient.query(`
        CREATE TABLE settings (
          id SERIAL PRIMARY KEY,
          setting_key VARCHAR(100) NOT NULL,
          setting_value TEXT
        )
      `);

      await sourceClient.query(`
        INSERT INTO settings (setting_key, setting_value) VALUES
        ('theme', 'dark'),
        ('locale', 'ja_JP')
      `);
    } finally {
      await sourceClient.end();
    }

    // Ensure target_db exists with some existing data (to test swap)
    const targetAdmin = new pg.Client({ ...PG_TARGET_CONFIG, database: 'postgres' });
    await targetAdmin.connect();
    try {
      await targetAdmin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'target_db' AND pid <> pg_backend_pid()`,
      );
      await targetAdmin.query('DROP DATABASE IF EXISTS target_db');
      await targetAdmin.query('CREATE DATABASE target_db');
    } finally {
      await targetAdmin.end();
    }

    const targetClient = new pg.Client(PG_TARGET_CONFIG);
    await targetClient.connect();
    try {
      await targetClient.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          first_name VARCHAR(100) NOT NULL,
          last_name VARCHAR(100) NOT NULL,
          phone VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await targetClient.query(`
        INSERT INTO users (email, first_name, last_name, phone) VALUES
        ('old@stale.com', 'Old', 'Data', '+0-000-000-0000')
      `);
    } finally {
      await targetClient.end();
    }

    // Clean up any leftover temp databases on target
    await cleanupTempDatabases(PG_TARGET_CONFIG);

    // Create fresh pools after DB recreation
    sourcePool = new pg.Pool(PG_SOURCE_CONFIG);
    targetPool = new pg.Pool(PG_TARGET_CONFIG);
  });

  afterEach(async () => {
    await cleanupTempDatabases(PG_TARGET_CONFIG);
    await sourcePool.end();
    await targetPool.end();
  });

  async function buildSyncConfig() {
    const adapter = createAdapter({ type: 'postgres', ...PG_SOURCE_CONFIG });
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const scanResult = await scan(adapter, detectors, { schemas: ['public'] });
      const config = generateConfig(scanResult, {
        source: { type: 'postgres', ...PG_SOURCE_CONFIG },
        target: { type: 'postgres', ...PG_TARGET_CONFIG },
      });
      const yaml = configToYaml(config);
      const loaded = loadConfigFromString(yaml);
      loaded.source.password = PG_SOURCE_CONFIG.password;
      loaded.target.password = PG_TARGET_CONFIG.password;
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

    // Reconnect to target (it was renamed during swap)
    targetPool = new pg.Pool(PG_TARGET_CONFIG);

    // Verify target_db has been replaced
    const targetRows = await getPgRows(targetPool, 'users');
    expect(targetRows).toHaveLength(3);

    // PII should be masked
    const sourceRows = await getPgRows(sourcePool, 'users');
    expect(targetRows[0]!['email']).not.toBe(sourceRows[0]!['email']);
    expect(targetRows[0]!['first_name']).not.toBe(sourceRows[0]!['first_name']);

    // Non-PII table should be copied as-is
    const settingsRows = await getPgRows(targetPool, 'settings');
    expect(settingsRows).toHaveLength(2);
    expect(settingsRows[0]!['setting_key']).toBe('theme');

    // created_at should be preserved
    expect(targetRows[0]!['created_at']).toEqual(sourceRows[0]!['created_at']);

    // Temp databases should be cleaned up
    const dbs = await listDatabases(PG_TARGET_CONFIG);
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
    const exists = await databaseExists(PG_TARGET_CONFIG, result.tempDbName);
    expect(exists).toBe(true);

    // Original target should be unchanged (no swap happened)
    const targetRows = await getPgRows(targetPool, 'users');
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]!['email']).toBe('old@stale.com');

    // Temp DB should have masked data
    const tempPool = new pg.Pool({
      ...PG_TARGET_CONFIG,
      database: result.tempDbName,
    });
    try {
      const tempRows = await getPgRows(tempPool, 'users');
      expect(tempRows).toHaveLength(3);
      // Masked — different from source
      const sourceRows = await getPgRows(sourcePool, 'users');
      expect(tempRows[0]!['email']).not.toBe(sourceRows[0]!['email']);
    } finally {
      await tempPool.end();
    }
  });

  it('should keep old DB when --keep-old is set', async () => {
    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    const result = await executeSync(config, registry, {
      keepOld: true,
    });

    expect(result.dryRun).toBe(false);

    // Reconnect to target (renamed during swap)
    targetPool = new pg.Pool(PG_TARGET_CONFIG);

    // An old database should exist
    const dbs = await listDatabases(PG_TARGET_CONFIG);
    const oldDbs = dbs.filter((db) => db.includes('_shinobi_old_'));
    expect(oldDbs).toHaveLength(1);

    // Old DB should contain the previous target data
    const oldPool = new pg.Pool({
      ...PG_TARGET_CONFIG,
      database: oldDbs[0]!,
    });
    try {
      const oldRows = await getPgRows(oldPool, 'users');
      expect(oldRows).toHaveLength(1);
      expect(oldRows[0]!['email']).toBe('old@stale.com');
    } finally {
      await oldPool.end();
    }

    // New target should have masked source data
    const targetRows = await getPgRows(targetPool, 'users');
    expect(targetRows).toHaveLength(3);
  });

  it('should produce deterministic results with same seed', async () => {
    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    // Run 1
    await executeSync(config, registry, { deterministic: true, seed: 'e2e-seed' });

    // Reconnect to target (renamed during swap)
    await targetPool.end();
    targetPool = new pg.Pool(PG_TARGET_CONFIG);
    const rows1 = await getPgRows(targetPool, 'users');

    // Reset target for run 2
    await targetPool.end();

    const targetAdmin = new pg.Client({ ...PG_TARGET_CONFIG, database: 'postgres' });
    await targetAdmin.connect();
    try {
      await targetAdmin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'target_db' AND pid <> pg_backend_pid()`,
      );
      await targetAdmin.query('DROP DATABASE IF EXISTS target_db');
      await targetAdmin.query('CREATE DATABASE target_db');
    } finally {
      await targetAdmin.end();
    }

    const targetClient = new pg.Client(PG_TARGET_CONFIG);
    await targetClient.connect();
    try {
      await targetClient.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          first_name VARCHAR(100),
          last_name VARCHAR(100),
          phone VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } finally {
      await targetClient.end();
    }

    await cleanupTempDatabases(PG_TARGET_CONFIG);

    // Run 2
    await executeSync(config, registry, { deterministic: true, seed: 'e2e-seed' });

    targetPool = new pg.Pool(PG_TARGET_CONFIG);
    const rows2 = await getPgRows(targetPool, 'users');

    // Same seed → same masked values
    expect(rows1[0]!['email']).toBe(rows2[0]!['email']);
    expect(rows1[0]!['first_name']).toBe(rows2[0]!['first_name']);
    expect(rows1[1]!['email']).toBe(rows2[1]!['email']);
  });

  it('should handle views during swap', async () => {
    // Add a view to source
    const sourceClient = new pg.Client(PG_SOURCE_CONFIG);
    await sourceClient.connect();
    try {
      await sourceClient.query(
        'CREATE VIEW active_users AS SELECT id, email FROM users WHERE id > 0',
      );
    } finally {
      await sourceClient.end();
    }

    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    const result = await executeSync(config, registry);
    expect(result.dryRun).toBe(false);

    // Reconnect to target (renamed during swap)
    await targetPool.end();
    targetPool = new pg.Pool(PG_TARGET_CONFIG);

    // View should exist in target after swap (comes for free with ALTER DATABASE RENAME)
    const viewResult = await targetPool.query(
      `SELECT table_name FROM information_schema.views WHERE table_schema = 'public' AND table_name = 'active_users'`,
    );
    expect(viewResult.rows).toHaveLength(1);

    // View should return data
    const viewRows = await targetPool.query('SELECT * FROM active_users');
    expect(viewRows.rows).toHaveLength(3);
  });

  it('should error when PII table has no primary key', async () => {
    // Create a table without PK that has PII
    const sourceClient = new pg.Client(PG_SOURCE_CONFIG);
    await sourceClient.connect();
    try {
      await sourceClient.query(`
        CREATE TABLE contact_log (
          email VARCHAR(255),
          phone VARCHAR(50),
          message TEXT,
          logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await sourceClient.query(`
        INSERT INTO contact_log (email, phone, message) VALUES
        ('test@example.com', '+1-555-000-0000', 'test')
      `);
    } finally {
      await sourceClient.end();
    }

    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    await expect(executeSync(config, registry)).rejects.toThrow('Primary key is required');
  });
});
