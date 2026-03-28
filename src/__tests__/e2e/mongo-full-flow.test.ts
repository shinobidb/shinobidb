import { type Db, MongoClient } from 'mongodb';

import { generateConfig, configToYaml } from '../../core/config-generator.js';
import { loadConfigFromString } from '../../core/config-loader.js';
import { executeMask } from '../../core/mask-executor.js';
import { scan } from '../../core/scanner.js';
import { createAdapter } from '../../db/factory.js';
import { createDefaultDetectors } from '../../detection/detector-factory.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';

import {
  MONGO_SOURCE_CONFIG,
  MONGO_TARGET_CONFIG,
  waitForMongo,
  createMongoClient,
  setupMongoSourceData,
  setupMongoTargetCollection,
  cleanupMongoDatabase,
  getMongoRows,
} from './mongo-helpers.js';

describe('E2E MongoDB: scan → config → mask flow', () => {
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

    await cleanupMongoDatabase(sourceDb);
    await cleanupMongoDatabase(targetDb);
    await setupMongoSourceData(sourceDb);
    await setupMongoTargetCollection(targetDb);
  }, 60_000);

  afterAll(async () => {
    await cleanupMongoDatabase(sourceDb);
    await cleanupMongoDatabase(targetDb);
    await sourceClient.close();
    await targetClient.close();
  });

  it('should scan MongoDB source database and detect PII columns', async () => {
    const adapter = createAdapter({ type: 'mongodb', ...MONGO_SOURCE_CONFIG });
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const result = await scan(adapter, detectors, {
        schemas: [MONGO_SOURCE_CONFIG.database],
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
    const adapter = createAdapter({ type: 'mongodb', ...MONGO_SOURCE_CONFIG });
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const scanResult = await scan(adapter, detectors, {
        schemas: [MONGO_SOURCE_CONFIG.database],
      });

      const config = generateConfig(scanResult, {
        source: { type: 'mongodb', ...MONGO_SOURCE_CONFIG },
        target: { type: 'mongodb', ...MONGO_TARGET_CONFIG },
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
    const adapter = createAdapter({ type: 'mongodb', ...MONGO_SOURCE_CONFIG });
    let config;
    try {
      await adapter.connect();
      const detectors = createDefaultDetectors();
      const scanResult = await scan(adapter, detectors, {
        schemas: [MONGO_SOURCE_CONFIG.database],
      });

      config = generateConfig(scanResult, {
        source: { type: 'mongodb', ...MONGO_SOURCE_CONFIG },
        target: { type: 'mongodb', ...MONGO_TARGET_CONFIG },
      });
    } finally {
      await adapter.destroy();
    }

    // Round-trip through YAML to test the full flow
    const yaml = configToYaml(config);
    const loadedConfig = loadConfigFromString(yaml);
    loadedConfig.source.password = MONGO_SOURCE_CONFIG.password;
    loadedConfig.target.password = MONGO_TARGET_CONFIG.password;

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
    const sourceRows = await getMongoRows(sourceDb, 'users');
    const targetRows = await getMongoRows(targetDb, 'users');

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
