import mysql from 'mysql2/promise';

import { generateConfig, configToYaml } from '../../core/config-generator.js';
import { loadConfigFromString } from '../../core/config-loader.js';
import { scan } from '../../core/scanner.js';
import { createAdapter } from '../../db/factory.js';
import { createDefaultDetectors } from '../../detection/detector-factory.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';
import { executeSync } from '../../sync/pipeline.js';
import { isShinobiTempDb } from '../../sync/temp-db.js';

import { SOURCE_CONFIG, TARGET_CONFIG, waitForMySQL, getRows } from './helpers.js';

// Helper: list all databases on a MySQL server
async function listDatabases(config: {
  host: string;
  port: number;
  user: string;
  password: string;
}): Promise<string[]> {
  const conn = await mysql.createConnection(config);
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>('SHOW DATABASES');
    return rows.map((r) => r['Database'] as string);
  } finally {
    await conn.end();
  }
}

// Helper: drop all shinobidb temp databases on a server
async function cleanupTempDatabases(config: {
  host: string;
  port: number;
  user: string;
  password: string;
}): Promise<void> {
  const conn = await mysql.createConnection(config);
  try {
    const dbs = await listDatabases(config);
    for (const db of dbs) {
      if (isShinobiTempDb(db)) {
        await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
      }
    }
  } finally {
    await conn.end();
  }
}

// Helper: check if a database exists
async function databaseExists(
  config: { host: string; port: number; user: string; password: string },
  dbName: string,
): Promise<boolean> {
  const dbs = await listDatabases(config);
  return dbs.includes(dbName);
}

describe('E2E: sync pipeline (MySQL)', () => {
  let sourcePool: mysql.Pool;
  let targetPool: mysql.Pool;

  beforeAll(async () => {
    await Promise.all([waitForMySQL(SOURCE_CONFIG), waitForMySQL(TARGET_CONFIG)]);
  }, 60_000);

  afterAll(async () => {
    await cleanupTempDatabases(TARGET_CONFIG);
  }, 30_000);

  // Clean state before each test — recreate pools after DB recreation
  beforeEach(async () => {
    // Recreate source_db with test data
    const sourceConn = await mysql.createConnection({
      host: SOURCE_CONFIG.host,
      port: SOURCE_CONFIG.port,
      user: SOURCE_CONFIG.user,
      password: SOURCE_CONFIG.password,
    });
    try {
      await sourceConn.query('DROP DATABASE IF EXISTS source_db');
      await sourceConn.query('CREATE DATABASE source_db');
      await sourceConn.query('USE source_db');

      await sourceConn.query(`
        CREATE TABLE users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          first_name VARCHAR(100) NOT NULL,
          last_name VARCHAR(100) NOT NULL,
          phone VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await sourceConn.query(`
        INSERT INTO users (email, first_name, last_name, phone) VALUES
        ('alice@example.com', 'Alice', 'Johnson', '+1-555-123-4567'),
        ('bob@company.org', 'Bob', 'Smith', '+1-555-987-6543'),
        ('charlie@test.io', 'Charlie', 'Brown', '+1-555-456-7890')
      `);

      // Non-PII table (should be copied but not masked)
      await sourceConn.query(`
        CREATE TABLE settings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          setting_key VARCHAR(100) NOT NULL,
          setting_value TEXT
        )
      `);

      await sourceConn.query(`
        INSERT INTO settings (setting_key, setting_value) VALUES
        ('theme', 'dark'),
        ('locale', 'ja_JP')
      `);
    } finally {
      await sourceConn.end();
    }

    // Ensure target_db exists with some existing data (to test swap)
    const targetConn = await mysql.createConnection({
      host: TARGET_CONFIG.host,
      port: TARGET_CONFIG.port,
      user: TARGET_CONFIG.user,
      password: TARGET_CONFIG.password,
    });
    try {
      await targetConn.query('DROP DATABASE IF EXISTS target_db');
      await targetConn.query('CREATE DATABASE target_db');
      await targetConn.query('USE target_db');

      await targetConn.query(`
        CREATE TABLE users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          first_name VARCHAR(100) NOT NULL,
          last_name VARCHAR(100) NOT NULL,
          phone VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await targetConn.query(`
        INSERT INTO users (email, first_name, last_name, phone) VALUES
        ('old@stale.com', 'Old', 'Data', '+0-000-000-0000')
      `);
    } finally {
      await targetConn.end();
    }

    // Clean up any leftover temp databases on target
    await cleanupTempDatabases(TARGET_CONFIG);

    // Create fresh pools after DB recreation
    sourcePool = mysql.createPool(SOURCE_CONFIG);
    targetPool = mysql.createPool(TARGET_CONFIG);
  });

  afterEach(async () => {
    await cleanupTempDatabases(TARGET_CONFIG);
    await sourcePool.end();
    await targetPool.end();
  });

  async function buildSyncConfig() {
    const adapter = createAdapter({ type: 'mysql', ...SOURCE_CONFIG });
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const scanResult = await scan(adapter, detectors, { schemas: ['source_db'] });
      const config = generateConfig(scanResult, {
        source: { type: 'mysql', ...SOURCE_CONFIG },
        target: { type: 'mysql', ...TARGET_CONFIG },
      });
      const yaml = configToYaml(config);
      const loaded = loadConfigFromString(yaml);
      loaded.source.password = SOURCE_CONFIG.password;
      loaded.target.password = TARGET_CONFIG.password;
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

    // Verify target_db has been replaced
    const targetRows = await getRows(targetPool, 'users');
    expect(targetRows).toHaveLength(3);

    // PII should be masked
    const sourceRows = await getRows(sourcePool, 'users');
    expect(targetRows[0]!['email']).not.toBe(sourceRows[0]!['email']);
    expect(targetRows[0]!['first_name']).not.toBe(sourceRows[0]!['first_name']);

    // Non-PII table should be copied as-is
    const settingsRows = await getRows(targetPool, 'settings');
    expect(settingsRows).toHaveLength(2);
    expect(settingsRows[0]!['setting_key']).toBe('theme');

    // created_at should be preserved
    expect(targetRows[0]!['created_at']).toEqual(sourceRows[0]!['created_at']);

    // Temp databases should be cleaned up
    const dbs = await listDatabases(TARGET_CONFIG);
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
    const exists = await databaseExists(TARGET_CONFIG, result.tempDbName);
    expect(exists).toBe(true);

    // Original target should be unchanged (no swap happened)
    const targetRows = await getRows(targetPool, 'users');
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]!['email']).toBe('old@stale.com');

    // Temp DB should have masked data
    const tempPool = mysql.createPool({
      ...TARGET_CONFIG,
      database: result.tempDbName,
    });
    try {
      const tempRows = await getRows(tempPool, 'users');
      expect(tempRows).toHaveLength(3);
      // Masked — different from source
      const sourceRows = await getRows(sourcePool, 'users');
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

    // An old database should exist
    const dbs = await listDatabases(TARGET_CONFIG);
    const oldDbs = dbs.filter((db) => db.includes('_shinobi_old_'));
    expect(oldDbs).toHaveLength(1);

    // Old DB should contain the previous target data
    const oldPool = mysql.createPool({
      ...TARGET_CONFIG,
      database: oldDbs[0]!,
    });
    try {
      const oldRows = await getRows(oldPool, 'users');
      expect(oldRows).toHaveLength(1);
      expect(oldRows[0]!['email']).toBe('old@stale.com');
    } finally {
      await oldPool.end();
    }

    // New target should have masked source data
    const targetRows = await getRows(targetPool, 'users');
    expect(targetRows).toHaveLength(3);
  });

  it('should produce deterministic results with same seed', async () => {
    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    // Run 1
    await executeSync(config, registry, { deterministic: true, seed: 'e2e-seed' });
    const rows1 = await getRows(targetPool, 'users');

    // Reset target for run 2 — close old pool first, then recreate DB and pool
    await targetPool.end();

    const targetConn = await mysql.createConnection({
      host: TARGET_CONFIG.host,
      port: TARGET_CONFIG.port,
      user: TARGET_CONFIG.user,
      password: TARGET_CONFIG.password,
    });
    try {
      await targetConn.query('DROP DATABASE IF EXISTS target_db');
      await targetConn.query('CREATE DATABASE target_db');
      await targetConn.query('USE target_db');
      await targetConn.query(`
        CREATE TABLE users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255),
          first_name VARCHAR(100),
          last_name VARCHAR(100),
          phone VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } finally {
      await targetConn.end();
    }

    targetPool = mysql.createPool(TARGET_CONFIG);

    // Run 2
    await executeSync(config, registry, { deterministic: true, seed: 'e2e-seed' });
    const rows2 = await getRows(targetPool, 'users');

    // Same seed → same masked values
    expect(rows1[0]!['email']).toBe(rows2[0]!['email']);
    expect(rows1[0]!['first_name']).toBe(rows2[0]!['first_name']);
    expect(rows1[1]!['email']).toBe(rows2[1]!['email']);
  });

  it('should handle views during swap', async () => {
    // Add a view to source
    const sourceConn = await mysql.createConnection({
      host: SOURCE_CONFIG.host,
      port: SOURCE_CONFIG.port,
      user: SOURCE_CONFIG.user,
      password: SOURCE_CONFIG.password,
      database: 'source_db',
    });
    try {
      await sourceConn.query(
        'CREATE VIEW active_users AS SELECT id, email FROM users WHERE id > 0',
      );
    } finally {
      await sourceConn.end();
    }

    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    const result = await executeSync(config, registry);
    expect(result.dryRun).toBe(false);

    // View should exist in target after swap
    const [views] = await targetPool.query<mysql.RowDataPacket[]>(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA = 'target_db'",
    );
    expect(views.some((v) => v['TABLE_NAME'] === 'active_users')).toBe(true);

    // View should return data
    const [viewRows] = await targetPool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM target_db.active_users',
    );
    expect(viewRows).toHaveLength(3);
  });

  it('should error when PII table has no primary key', async () => {
    // Create a table without PK that has PII
    const sourceConn = await mysql.createConnection({
      host: SOURCE_CONFIG.host,
      port: SOURCE_CONFIG.port,
      user: SOURCE_CONFIG.user,
      password: SOURCE_CONFIG.password,
      database: 'source_db',
    });
    try {
      await sourceConn.query(`
        CREATE TABLE contact_log (
          email VARCHAR(255),
          phone VARCHAR(50),
          message TEXT,
          logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await sourceConn.query(`
        INSERT INTO contact_log (email, phone, message) VALUES
        ('test@example.com', '+1-555-000-0000', 'test')
      `);
    } finally {
      await sourceConn.end();
    }

    const config = await buildSyncConfig();
    const registry = createDefaultRegistry();

    await expect(executeSync(config, registry)).rejects.toThrow('Primary key is required');
  });
});
