import type { PiiDetectionResult } from '../../detection/types.js';
import { diffScans } from '../scan-diff.js';
import type { ScanResult } from '../scanner.js';

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

function makeScanResult(detections: PiiDetectionResult[]): ScanResult {
  return {
    detections,
    tablesScanned: 1,
    columnsScanned: 10,
    scannedTables: [],
  };
}

describe('diffScans', () => {
  it('should detect no changes when scans are identical', () => {
    const detection = makeDetection();
    const baseline = makeScanResult([detection]);
    const current = makeScanResult([detection]);

    const diff = diffScans(baseline, current);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchanged).toBe(1);
  });

  it('should detect added columns', () => {
    const existing = makeDetection();
    const added = makeDetection({
      column: 'phone',
      category: 'phone',
      suggestedMaskingStrategy: 'fake_phone',
    });

    const baseline = makeScanResult([existing]);
    const current = makeScanResult([existing, added]);

    const diff = diffScans(baseline, current);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.column).toBe('phone');
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchanged).toBe(1);
  });

  it('should detect removed columns', () => {
    const existing = makeDetection();
    const toRemove = makeDetection({
      column: 'phone',
      category: 'phone',
      suggestedMaskingStrategy: 'fake_phone',
    });

    const baseline = makeScanResult([existing, toRemove]);
    const current = makeScanResult([existing]);

    const diff = diffScans(baseline, current);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]?.column).toBe('phone');
    expect(diff.unchanged).toBe(1);
  });

  it('should detect changed category', () => {
    const before = makeDetection({ category: 'name' });
    const after = makeDetection({ category: 'first_name' });

    const diff = diffScans(makeScanResult([before]), makeScanResult([after]));

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.before.category).toBe('name');
    expect(diff.changed[0]?.after.category).toBe('first_name');
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('should detect changed confidence', () => {
    const before = makeDetection({ confidence: 0.7 });
    const after = makeDetection({ confidence: 0.95 });

    const diff = diffScans(makeScanResult([before]), makeScanResult([after]));

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.before.confidence).toBe(0.7);
    expect(diff.changed[0]?.after.confidence).toBe(0.95);
  });

  it('should detect changed strategy', () => {
    const before = makeDetection({ suggestedMaskingStrategy: 'hash_email' });
    const after = makeDetection({ suggestedMaskingStrategy: 'redact' });

    const diff = diffScans(makeScanResult([before]), makeScanResult([after]));

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.before.strategy).toBe('hash_email');
    expect(diff.changed[0]?.after.strategy).toBe('redact');
  });

  it('should handle empty baselines', () => {
    const detection = makeDetection();

    const diff = diffScans(makeScanResult([]), makeScanResult([detection]));

    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toBe(0);
  });

  it('should handle empty current scans', () => {
    const detection = makeDetection();

    const diff = diffScans(makeScanResult([detection]), makeScanResult([]));

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(1);
    expect(diff.unchanged).toBe(0);
  });

  it('should handle multiple tables and schemas', () => {
    const d1 = makeDetection({ schema: 'app', table: 'users', column: 'email' });
    const d2 = makeDetection({
      schema: 'app',
      table: 'orders',
      column: 'address',
      category: 'address',
    });
    const d3 = makeDetection({
      schema: 'audit',
      table: 'logs',
      column: 'ip',
      category: 'ip_address',
    });

    const baseline = makeScanResult([d1]);
    const current = makeScanResult([d1, d2, d3]);

    const diff = diffScans(baseline, current);

    expect(diff.added).toHaveLength(2);
    expect(diff.unchanged).toBe(1);
  });

  it('should handle both additions and removals simultaneously', () => {
    const kept = makeDetection({ column: 'email' });
    const removed = makeDetection({ column: 'old_phone', category: 'phone' });
    const added = makeDetection({ column: 'mobile', category: 'phone' });

    const baseline = makeScanResult([kept, removed]);
    const current = makeScanResult([kept, added]);

    const diff = diffScans(baseline, current);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.column).toBe('mobile');
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]?.column).toBe('old_phone');
    expect(diff.unchanged).toBe(1);
  });
});
