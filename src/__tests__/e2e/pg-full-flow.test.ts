import pg from 'pg';

import { generateConfig, configToYaml } from '../../core/config-generator.js';
import { loadConfigFromString } from '../../core/config-loader.js';
import { executeMask } from '../../core/mask-executor.js';
import { scan } from '../../core/scanner.js';
import { createAdapter } from '../../db/factory.js';
import { createDefaultDetectors } from '../../detection/detector-factory.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';

import {
  PG_SOURCE_CONFIG,
  PG_TARGET_CONFIG,
  waitForPostgres,
  setupPgSourceData,
  setupPgTargetSchema,
  cleanupPgDatabase,
  getPgRows,
} from './pg-helpers.js';

describe('E2E PostgreSQL: scan → config → mask flow', () => {
  let sourcePool: pg.Pool;
  let targetPool: pg.Pool;

  beforeAll(async () => {
    await Promise.all([waitForPostgres(PG_SOURCE_CONFIG), waitForPostgres(PG_TARGET_CONFIG)]);

    sourcePool = new pg.Pool(PG_SOURCE_CONFIG);
    targetPool = new pg.Pool(PG_TARGET_CONFIG);

    await cleanupPgDatabase(sourcePool);
    await cleanupPgDatabase(targetPool);
    await setupPgSourceData(sourcePool);
    await setupPgTargetSchema(targetPool);
  }, 60_000);

  afterAll(async () => {
    await cleanupPgDatabase(sourcePool);
    await cleanupPgDatabase(targetPool);
    await sourcePool.end();
    await targetPool.end();
  });

  it('should scan PostgreSQL source database and detect PII columns', async () => {
    const adapter = createAdapter({ type: 'postgres', ...PG_SOURCE_CONFIG });
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const result = await scan(adapter, detectors, {
        schemas: ['public'],
      });

      expect(result.tablesScanned).toBe(1);
      expect(result.detections.length).toBeGreaterThanOrEqual(5);

      const categories = result.detections.map((d) => d.category);
      expect(categories).toContain('email');
      expect(categories).toContain('first_name');
      expect(categories).toContain('last_name');
      expect(categories).toContain('phone');
      expect(categories).toContain('ip_address');
    } finally {
      await adapter.destroy();
    }
  });

  it('should generate config YAML from scan results', async () => {
    const adapter = createAdapter({ type: 'postgres', ...PG_SOURCE_CONFIG });
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const scanResult = await scan(adapter, detectors, {
        schemas: ['public'],
      });

      const config = generateConfig(scanResult, {
        source: { type: 'postgres', ...PG_SOURCE_CONFIG },
        target: { type: 'postgres', ...PG_TARGET_CONFIG },
      });

      expect(config.version).toBe('1');
      expect(config.tables.length).toBe(1);
      expect(config.tables[0]!.table).toBe('users');
      expect(config.tables[0]!.columns.length).toBeGreaterThanOrEqual(5);

      const yaml = configToYaml(config);
      expect(yaml).toContain('version:');
      expect(yaml).toContain('users');
    } finally {
      await adapter.destroy();
    }
  });

  it('should mask data from source to target', async () => {
    const adapter = createAdapter({ type: 'postgres', ...PG_SOURCE_CONFIG });
    let config;
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const scanResult = await scan(adapter, detectors, {
        schemas: ['public'],
      });

      config = generateConfig(scanResult, {
        source: { type: 'postgres', ...PG_SOURCE_CONFIG },
        target: { type: 'postgres', ...PG_TARGET_CONFIG },
      });
    } finally {
      await adapter.destroy();
    }

    // Round-trip through YAML to test the full flow
    const yaml = configToYaml(config);
    const loadedConfig = loadConfigFromString(yaml);
    loadedConfig.source.password = PG_SOURCE_CONFIG.password;
    loadedConfig.target.password = PG_TARGET_CONFIG.password;

    const source = createAdapter(loadedConfig.source);
    const target = createAdapter(loadedConfig.target);
    const registry = createDefaultRegistry();

    try {
      await source.connect();
      await target.connect();

      const result = await executeMask(source, target, loadedConfig, registry);

      expect(result.tablesProcessed).toBe(1);
      expect(result.rowsProcessed).toBe(3);
      expect(result.rowsWritten).toBe(3);
    } finally {
      await Promise.all([source.destroy(), target.destroy()]);
    }

    // Verify masked data
    const sourceRows = await getPgRows(sourcePool, 'users');
    const targetRows = await getPgRows(targetPool, 'users');

    expect(targetRows).toHaveLength(3);

    // Emails should be masked but keep domain
    expect(targetRows[0]!['email']).not.toBe(sourceRows[0]!['email']);
    expect(targetRows[0]!['email'] as string).toContain('@example.com');

    // Names should be different
    expect(targetRows[0]!['first_name']).not.toBe(sourceRows[0]!['first_name']);
    expect(targetRows[0]!['last_name']).not.toBe(sourceRows[0]!['last_name']);

    // Phone should be masked
    expect(targetRows[0]!['phone']).not.toBe(sourceRows[0]!['phone']);

    // IP should be masked
    expect(targetRows[0]!['ip_address']).not.toBe(sourceRows[0]!['ip_address']);
    expect(targetRows[0]!['ip_address'] as string).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    // Notes (free_text) should have PII scrubbed
    const sourceNotes = sourceRows[0]!['notes'] as string;
    const targetNotes = targetRows[0]!['notes'] as string;
    expect(targetNotes).not.toContain('alice@example.com');
    expect(sourceNotes).toContain('alice@example.com');

    // created_at should be preserved (not a PII column)
    expect(targetRows[0]!['created_at']).toEqual(sourceRows[0]!['created_at']);
  });
});
