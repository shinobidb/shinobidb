import { readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScanResult } from '../scanner.js';
import { saveSnapshot, loadSnapshot } from '../snapshot.js';

const testDir = join(tmpdir(), 'shinobidb-snapshot-test');

const sampleResult: ScanResult = {
  detections: [
    {
      schema: 'public',
      table: 'users',
      column: 'email',
      category: 'email',
      confidence: 0.95,
      reasoning: 'column name match',
      suggestedMaskingStrategy: 'hash_email',
    },
  ],
  tablesScanned: 1,
  columnsScanned: 5,
};

beforeEach(async () => {
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('saveSnapshot', () => {
  it('should save scan result to file with metadata', async () => {
    const filePath = join(testDir, 'snapshot.json');
    await saveSnapshot(filePath, sampleResult);

    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;

    expect(data.version).toBe(1);
    expect(data.timestamp).toBeDefined();
    expect(data.tablesScanned).toBe(1);
    expect(data.columnsScanned).toBe(5);
    expect(data.detections).toHaveLength(1);
  });

  it('should create parent directories if needed', async () => {
    const filePath = join(testDir, 'nested', 'dir', 'snapshot.json');
    await saveSnapshot(filePath, sampleResult);

    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data.version).toBe(1);
  });
});

describe('loadSnapshot', () => {
  it('should load scan result from file', async () => {
    const filePath = join(testDir, 'snapshot.json');
    await saveSnapshot(filePath, sampleResult);

    const loaded = await loadSnapshot(filePath);

    expect(loaded.tablesScanned).toBe(1);
    expect(loaded.columnsScanned).toBe(5);
    expect(loaded.detections).toHaveLength(1);
    expect(loaded.detections[0]?.column).toBe('email');
  });

  it('should throw for non-existent file', async () => {
    await expect(loadSnapshot(join(testDir, 'nonexistent.json'))).rejects.toThrow();
  });

  it('should round-trip scan results correctly', async () => {
    const filePath = join(testDir, 'roundtrip.json');
    await saveSnapshot(filePath, sampleResult);
    const loaded = await loadSnapshot(filePath);

    expect(loaded.detections).toEqual(sampleResult.detections);
    expect(loaded.tablesScanned).toBe(sampleResult.tablesScanned);
    expect(loaded.columnsScanned).toBe(sampleResult.columnsScanned);
  });
});
