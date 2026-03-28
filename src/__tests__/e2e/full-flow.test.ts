import mysql from 'mysql2/promise';

import { generateConfig, configToYaml } from '../../core/config-generator.js';
import { loadConfigFromString } from '../../core/config-loader.js';
import { executeMask } from '../../core/mask-executor.js';
import { scan } from '../../core/scanner.js';
import { createAdapter } from '../../db/factory.js';
import { createDefaultDetectors } from '../../detection/detector-factory.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';

import {
  SOURCE_CONFIG,
  TARGET_CONFIG,
  waitForMySQL,
  setupSourceData,
  setupTargetSchema,
  cleanupDatabase,
  getRows,
} from './helpers.js';

describe('E2E: scan → config → mask flow', () => {
  let sourcePool: mysql.Pool;
  let targetPool: mysql.Pool;

  beforeAll(async () => {
    await Promise.all([waitForMySQL(SOURCE_CONFIG), waitForMySQL(TARGET_CONFIG)]);

    sourcePool = mysql.createPool(SOURCE_CONFIG);
    targetPool = mysql.createPool(TARGET_CONFIG);

    await cleanupDatabase(sourcePool);
    await cleanupDatabase(targetPool);
    await setupSourceData(sourcePool);
    await setupTargetSchema(targetPool);
  }, 60_000);

  afterAll(async () => {
    await cleanupDatabase(sourcePool);
    await cleanupDatabase(targetPool);
    await sourcePool.end();
    await targetPool.end();
  });

  it('should scan source database and detect PII columns', async () => {
    const adapter = createAdapter({ type: 'mysql', ...SOURCE_CONFIG });
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const result = await scan(adapter, detectors, {
        schemas: ['source_db'],
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
    const adapter = createAdapter({ type: 'mysql', ...SOURCE_CONFIG });
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const scanResult = await scan(adapter, detectors, {
        schemas: ['source_db'],
      });

      const config = generateConfig(scanResult, {
        source: { type: 'mysql', ...SOURCE_CONFIG },
        target: { type: 'mysql', ...TARGET_CONFIG },
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
    const adapter = createAdapter({ type: 'mysql', ...SOURCE_CONFIG });
    let config;
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const scanResult = await scan(adapter, detectors, {
        schemas: ['source_db'],
      });

      config = generateConfig(scanResult, {
        source: { type: 'mysql', ...SOURCE_CONFIG },
        target: { type: 'mysql', ...TARGET_CONFIG },
      });
    } finally {
      await adapter.destroy();
    }

    // Round-trip through YAML to test the full flow
    const yaml = configToYaml(config);
    const loadedConfig = loadConfigFromString(yaml);
    loadedConfig.source.password = SOURCE_CONFIG.password;
    loadedConfig.target.password = TARGET_CONFIG.password;

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
    const sourceRows = await getRows(sourcePool, 'users');
    const targetRows = await getRows(targetPool, 'users');

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
