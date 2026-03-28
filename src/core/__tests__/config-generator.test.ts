import type { PiiDetectionResult } from '../../detection/types.js';
import { generateConfig, configToYaml } from '../config-generator.js';
import type { ScanResult } from '../scanner.js';

function makeDetection(overrides: Partial<PiiDetectionResult> = {}): PiiDetectionResult {
  return {
    schema: 'test_db',
    table: 'users',
    column: 'email',
    category: 'email',
    confidence: 0.95,
    reasoning: 'test',
    suggestedMaskingStrategy: 'hash_email',
    ...overrides,
  };
}

function makeScanResult(detections: PiiDetectionResult[]): ScanResult {
  return {
    detections,
    tablesScanned: 1,
    columnsScanned: 10,
  };
}

describe('generateConfig', () => {
  it('should generate config from scan results', () => {
    const scanResult = makeScanResult([
      makeDetection(),
      makeDetection({
        column: 'first_name',
        category: 'first_name',
        confidence: 0.95,
        suggestedMaskingStrategy: 'fake_first_name',
      }),
    ]);

    const config = generateConfig(scanResult);

    expect(config.version).toBe('1');
    expect(config.tables).toHaveLength(1);
    expect(config.tables[0]!.schema).toBe('test_db');
    expect(config.tables[0]!.table).toBe('users');
    expect(config.tables[0]!.columns).toHaveLength(2);
    expect(config.tables[0]!.columns[0]).toEqual({
      name: 'email',
      strategy: 'hash_email',
    });
    expect(config.tables[0]!.columns[1]).toEqual({
      name: 'first_name',
      strategy: 'fake_first_name',
    });
  });

  it('should group detections by schema.table', () => {
    const scanResult = makeScanResult([
      makeDetection({ schema: 'db1', table: 'users', column: 'email' }),
      makeDetection({ schema: 'db1', table: 'users', column: 'phone' }),
      makeDetection({ schema: 'db1', table: 'orders', column: 'address' }),
      makeDetection({ schema: 'db2', table: 'users', column: 'email' }),
    ]);

    const config = generateConfig(scanResult);

    expect(config.tables).toHaveLength(3);
    expect(config.tables[0]!.schema).toBe('db1');
    expect(config.tables[0]!.table).toBe('users');
    expect(config.tables[0]!.columns).toHaveLength(2);
    expect(config.tables[1]!.schema).toBe('db1');
    expect(config.tables[1]!.table).toBe('orders');
    expect(config.tables[2]!.schema).toBe('db2');
    expect(config.tables[2]!.table).toBe('users');
  });

  it('should filter detections below minConfidence', () => {
    const scanResult = makeScanResult([
      makeDetection({ column: 'email', confidence: 0.95 }),
      makeDetection({ column: 'name', confidence: 0.4 }),
      makeDetection({ column: 'phone', confidence: 0.7 }),
    ]);

    const config = generateConfig(scanResult, { minConfidence: 0.5 });

    expect(config.tables[0]!.columns).toHaveLength(2);
    expect(config.tables[0]!.columns.map((c) => c.name)).toEqual(['email', 'phone']);
  });

  it('should use default minConfidence of 0.5', () => {
    const scanResult = makeScanResult([
      makeDetection({ confidence: 0.5 }),
      makeDetection({ column: 'weak', confidence: 0.49 }),
    ]);

    const config = generateConfig(scanResult);

    expect(config.tables[0]!.columns).toHaveLength(1);
  });

  it('should apply custom connection configs', () => {
    const scanResult = makeScanResult([makeDetection()]);

    const config = generateConfig(scanResult, {
      source: { host: 'prod-db.example.com', port: 3307, user: 'reader' },
      target: { host: 'staging-db.example.com', user: 'writer' },
    });

    expect(config.source.host).toBe('prod-db.example.com');
    expect(config.source.port).toBe(3307);
    expect(config.source.user).toBe('reader');
    expect(config.target.host).toBe('staging-db.example.com');
    expect(config.target.user).toBe('writer');
    expect(config.target.port).toBe(3306);
  });

  it('should apply custom mask options', () => {
    const scanResult = makeScanResult([makeDetection()]);

    const config = generateConfig(scanResult, {
      batchSize: 5000,
      deterministic: false,
      seed: 'custom-seed',
      truncateTarget: false,
    });

    expect(config.options).toEqual({
      batchSize: 5000,
      deterministic: false,
      seed: 'custom-seed',
      truncateTarget: false,
    });
  });

  it('should use sensible defaults for mask options', () => {
    const scanResult = makeScanResult([makeDetection()]);
    const config = generateConfig(scanResult);

    expect(config.options).toEqual({
      batchSize: 1000,
      deterministic: true,
      seed: 'shinobidb-default-seed',
      truncateTarget: true,
    });
  });

  it('should return empty tables when no detections pass filter', () => {
    const scanResult = makeScanResult([makeDetection({ confidence: 0.1 })]);

    const config = generateConfig(scanResult, { minConfidence: 0.5 });

    expect(config.tables).toHaveLength(0);
  });

  it('should return empty tables when scan has no detections', () => {
    const scanResult = makeScanResult([]);
    const config = generateConfig(scanResult);

    expect(config.tables).toHaveLength(0);
  });
});

describe('configToYaml', () => {
  it('should serialize config to valid YAML string', () => {
    const scanResult = makeScanResult([
      makeDetection(),
      makeDetection({
        column: 'phone',
        suggestedMaskingStrategy: 'fake_phone',
      }),
    ]);
    const config = generateConfig(scanResult);
    const yaml = configToYaml(config);

    expect(yaml).toContain('version: "1"');
    expect(yaml).toContain('source:');
    expect(yaml).toContain('target:');
    expect(yaml).toContain('tables:');
    expect(yaml).toContain('strategy: hash_email');
    expect(yaml).toContain('strategy: fake_phone');
  });

  it('should produce parseable YAML that round-trips', () => {
    const { parse } = require('yaml');
    const scanResult = makeScanResult([makeDetection()]);
    const config = generateConfig(scanResult);
    const yaml = configToYaml(config);
    const parsed = parse(yaml);

    expect(parsed.version).toBe('1');
    expect(parsed.tables).toHaveLength(1);
    expect(parsed.tables[0].columns[0].name).toBe('email');
    expect(parsed.tables[0].columns[0].strategy).toBe('hash_email');
  });
});
