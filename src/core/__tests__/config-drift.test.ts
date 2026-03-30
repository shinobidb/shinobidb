import type { ShinobiConfig, TableMaskConfig } from '../../config/types.js';
import type { PiiDetectionResult } from '../../detection/types.js';
import { detectDrift, parseIgnoreList } from '../config-drift.js';
import type { ScanResult } from '../scanner.js';

jest.mock('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), success: jest.fn() },
}));

function makeDetection(overrides: Partial<PiiDetectionResult> = {}): PiiDetectionResult {
  return {
    schema: 'public',
    table: 'users',
    column: 'email',
    category: 'email',
    confidence: 0.95,
    reasoning: 'column name match',
    suggestedMaskingStrategy: 'hash_email',
    ...overrides,
  };
}

function makeScanResult(
  detections: PiiDetectionResult[],
  scannedTables?: Array<{ schema: string; table: string }>,
): ScanResult {
  return {
    detections,
    tablesScanned: 1,
    columnsScanned: 10,
    scannedTables: scannedTables ?? [],
  };
}

function makeTableConfig(overrides: Partial<TableMaskConfig> = {}): TableMaskConfig {
  return {
    schema: 'public',
    table: 'users',
    columns: [],
    ...overrides,
  };
}

function makeConfig(tables: TableMaskConfig[], ignore?: string[]): ShinobiConfig {
  return {
    version: '1',
    source: { type: 'mysql', host: 'localhost', port: 3306, user: 'root', password: '' },
    target: { type: 'mysql', host: 'localhost', port: 3306, user: 'root', password: '' },
    options: { batchSize: 1000, deterministic: true, seed: 'test', truncateTarget: true },
    tables,
    ignore,
  };
}

function makeSchemaMap(entries: Record<string, string[]>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const [key, cols] of Object.entries(entries)) {
    map.set(key, new Set(cols));
  }
  return map;
}

describe('parseIgnoreList', () => {
  it('should return empty set for undefined', () => {
    expect(parseIgnoreList(undefined)).toEqual(new Set());
  });

  it('should return set from array', () => {
    const result = parseIgnoreList(['public.users.email', 'public.logs.ip']);
    expect(result.has('public.users.email')).toBe(true);
    expect(result.has('public.logs.ip')).toBe(true);
    expect(result.size).toBe(2);
  });
});

describe('detectDrift', () => {
  it('should detect no drift when config covers all scan detections', () => {
    const config = makeConfig([
      makeTableConfig({
        columns: [{ name: 'email', strategy: 'hash_email' }],
      }),
    ]);
    const scan = makeScanResult([makeDetection()]);
    const schemaMap = makeSchemaMap({ 'public.users': ['id', 'email', 'name'] });

    const result = detectDrift(config, scan, schemaMap);

    expect(result.items).toHaveLength(0);
    expect(result.hasActionableDrift).toBe(false);
    expect(result.summary).toEqual({ critical: 0, warning: 0, info: 0 });
  });

  // Case 1: copyOnly table with PII
  it('should report CRITICAL when copyOnly table has PII', () => {
    const config = makeConfig([makeTableConfig({ copyOnly: true })]);
    const scan = makeScanResult([makeDetection()]);
    const schemaMap = makeSchemaMap({ 'public.users': ['id', 'email'] });

    const result = detectDrift(config, scan, schemaMap);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.type).toBe('copyonly_has_pii');
    expect(result.items[0]!.severity).toBe('critical');
    expect(result.items[0]!.column).toBe('email');
    expect(result.hasActionableDrift).toBe(true);
    expect(result.summary.critical).toBe(1);
  });

  it('should suppress copyOnly PII when column is in ignore list', () => {
    const config = makeConfig([makeTableConfig({ copyOnly: true })], ['public.users.email']);
    const scan = makeScanResult([makeDetection()]);
    const schemaMap = makeSchemaMap({ 'public.users': ['id', 'email'] });

    const result = detectDrift(config, scan, schemaMap);

    expect(result.items).toHaveLength(0);
    expect(result.hasActionableDrift).toBe(false);
  });

  // Case 2: New PII column not in config
  it('should report WARNING for new PII column not in config', () => {
    const config = makeConfig([
      makeTableConfig({
        columns: [{ name: 'email', strategy: 'hash_email' }],
      }),
    ]);
    const scan = makeScanResult([
      makeDetection(),
      makeDetection({ column: 'phone', category: 'phone', suggestedMaskingStrategy: 'fake_phone' }),
    ]);
    const schemaMap = makeSchemaMap({ 'public.users': ['id', 'email', 'phone'] });

    const result = detectDrift(config, scan, schemaMap);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.type).toBe('new_pii_column');
    expect(result.items[0]!.severity).toBe('warning');
    expect(result.items[0]!.column).toBe('phone');
  });

  it('should suppress new PII column when in ignore list', () => {
    const config = makeConfig(
      [makeTableConfig({ columns: [{ name: 'email', strategy: 'hash_email' }] })],
      ['public.users.phone'],
    );
    const scan = makeScanResult([
      makeDetection(),
      makeDetection({ column: 'phone', category: 'phone', suggestedMaskingStrategy: 'fake_phone' }),
    ]);
    const schemaMap = makeSchemaMap({ 'public.users': ['id', 'email', 'phone'] });

    const result = detectDrift(config, scan, schemaMap);

    expect(result.items).toHaveLength(0);
  });

  // Case 3: Config column no longer in DB
  it('should report WARNING for config column not in DB', () => {
    const config = makeConfig([
      makeTableConfig({
        columns: [
          { name: 'email', strategy: 'hash_email' },
          { name: 'old_field', strategy: 'redact' },
        ],
      }),
    ]);
    const scan = makeScanResult([makeDetection()]);
    const schemaMap = makeSchemaMap({ 'public.users': ['id', 'email'] });

    const result = detectDrift(config, scan, schemaMap);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.type).toBe('column_not_in_db');
    expect(result.items[0]!.severity).toBe('warning');
    expect(result.items[0]!.column).toBe('old_field');
  });

  // Case 4: Config table no longer in DB
  it('should report WARNING for config table not in DB', () => {
    const config = makeConfig([makeTableConfig({ table: 'deleted_table', columns: [] })]);
    const scan = makeScanResult([]);
    const schemaMap = makeSchemaMap({});

    const result = detectDrift(config, scan, schemaMap);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.type).toBe('table_not_in_db');
    expect(result.items[0]!.severity).toBe('warning');
    expect(result.items[0]!.table).toBe('deleted_table');
  });

  // Case 5: Strategy mismatch
  it('should report INFO for strategy mismatch', () => {
    const config = makeConfig([
      makeTableConfig({
        columns: [{ name: 'email', strategy: 'redact' }],
      }),
    ]);
    const scan = makeScanResult([makeDetection({ suggestedMaskingStrategy: 'hash_email' })]);
    const schemaMap = makeSchemaMap({ 'public.users': ['id', 'email'] });

    const result = detectDrift(config, scan, schemaMap);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.type).toBe('strategy_mismatch');
    expect(result.items[0]!.severity).toBe('info');
    expect(result.items[0]!.configStrategy).toBe('redact');
  });

  // minConfidence filtering
  it('should ignore detections below minConfidence', () => {
    const config = makeConfig([makeTableConfig({ copyOnly: true })]);
    const scan = makeScanResult([makeDetection({ confidence: 0.3 })]);
    const schemaMap = makeSchemaMap({ 'public.users': ['id', 'email'] });

    const result = detectDrift(config, scan, schemaMap, { minConfidence: 0.5 });

    expect(result.items).toHaveLength(0);
  });

  // Multiple tables
  it('should detect drift across multiple tables', () => {
    const config = makeConfig([
      makeTableConfig({
        columns: [{ name: 'email', strategy: 'hash_email' }],
      }),
      makeTableConfig({
        table: 'orders',
        copyOnly: true,
      }),
    ]);
    const scan = makeScanResult([
      makeDetection(),
      makeDetection({ table: 'orders', column: 'customer_email', category: 'email' }),
      makeDetection({ column: 'phone', category: 'phone', suggestedMaskingStrategy: 'fake_phone' }),
    ]);
    const schemaMap = makeSchemaMap({
      'public.users': ['id', 'email', 'phone'],
      'public.orders': ['id', 'customer_email', 'total'],
    });

    const result = detectDrift(config, scan, schemaMap);

    expect(result.summary.critical).toBe(1); // copyOnly orders.customer_email
    expect(result.summary.warning).toBe(1); // new PII users.phone
    expect(result.items).toHaveLength(2);
  });

  // hasActionableDrift with only INFO
  it('should set hasActionableDrift false when only INFO items', () => {
    const config = makeConfig([
      makeTableConfig({
        columns: [{ name: 'email', strategy: 'redact' }],
      }),
    ]);
    const scan = makeScanResult([makeDetection()]);
    const schemaMap = makeSchemaMap({ 'public.users': ['id', 'email'] });

    const result = detectDrift(config, scan, schemaMap);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.severity).toBe('info');
    expect(result.hasActionableDrift).toBe(false);
  });

  // Empty config and scan
  it('should handle empty config and empty scan', () => {
    const config = makeConfig([]);
    const scan = makeScanResult([]);
    const schemaMap = makeSchemaMap({});

    const result = detectDrift(config, scan, schemaMap);

    expect(result.items).toHaveLength(0);
    expect(result.hasActionableDrift).toBe(false);
  });

  // Case 1 should not duplicate into Case 2
  it('should not report copyOnly PII again as new_pii_column', () => {
    const config = makeConfig([makeTableConfig({ copyOnly: true })]);
    const scan = makeScanResult([makeDetection()]);
    const schemaMap = makeSchemaMap({ 'public.users': ['id', 'email'] });

    const result = detectDrift(config, scan, schemaMap);

    const types = result.items.map((i) => i.type);
    expect(types).toEqual(['copyonly_has_pii']);
    expect(types).not.toContain('new_pii_column');
  });

  // Case 3 should skip tables handled by Case 4
  it('should not report column_not_in_db when table itself is missing', () => {
    const config = makeConfig([
      makeTableConfig({
        table: 'gone_table',
        columns: [{ name: 'email', strategy: 'hash_email' }],
      }),
    ]);
    const scan = makeScanResult([]);
    const schemaMap = makeSchemaMap({});

    const result = detectDrift(config, scan, schemaMap);

    const types = result.items.map((i) => i.type);
    expect(types).toEqual(['table_not_in_db']);
    expect(types).not.toContain('column_not_in_db');
  });
});
