import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShinobiConfig } from '../../config/types.js';
import type { AuditRecord } from '../audit-logger.js';
import { buildAuditRecord, writeAuditLog } from '../audit-logger.js';
import type { MaskResult } from '../mask-executor.js';

function makeConfig(): ShinobiConfig {
  return {
    version: '1',
    source: {
      type: 'mysql',
      host: 'source.example.com',
      port: 3306,
      user: 'root',
      password: 'secret-should-not-appear',
      database: 'prod_db',
    },
    target: {
      type: 'mysql',
      host: 'target.example.com',
      port: 3306,
      user: 'root',
      password: 'secret-should-not-appear',
      database: 'staging_db',
    },
    options: {
      batchSize: 1000,
      deterministic: true,
      seed: 'test-seed',
      truncateTarget: true,
    },
    tables: [
      {
        schema: 'prod_db',
        table: 'users',
        columns: [
          { name: 'email', strategy: 'hash_email' },
          { name: 'first_name', strategy: 'fake_first_name' },
        ],
      },
      {
        schema: 'prod_db',
        table: 'logs',
        columns: [],
        copyOnly: true,
      },
    ],
  };
}

function makeResult(): MaskResult {
  return {
    tablesProcessed: 2,
    rowsProcessed: 150,
    rowsWritten: 150,
    tableDetails: [
      {
        schema: 'prod_db',
        table: 'users',
        rowsProcessed: 100,
        rowsWritten: 100,
        copyOnly: false,
        maskedColumns: ['email', 'first_name'],
      },
      {
        schema: 'prod_db',
        table: 'logs',
        rowsProcessed: 50,
        rowsWritten: 50,
        copyOnly: true,
        maskedColumns: [],
      },
    ],
  };
}

describe('buildAuditRecord', () => {
  it('should build an audit record from config and result', () => {
    const record = buildAuditRecord({
      config: makeConfig(),
      result: makeResult(),
      durationMs: 1234,
      syncSchema: true,
      concurrency: 4,
    });

    expect(record.timestamp).toBeDefined();
    expect(record.durationMs).toBe(1234);
    expect(record.source).toEqual({
      type: 'mysql',
      host: 'source.example.com',
      database: 'prod_db',
    });
    expect(record.target).toEqual({
      type: 'mysql',
      host: 'target.example.com',
      database: 'staging_db',
    });
    expect(record.options).toEqual({
      syncSchema: true,
      concurrency: 4,
      deterministic: true,
      truncateTarget: true,
    });
    expect(record.tables).toHaveLength(2);
    expect(record.tables[0]!.maskedColumns).toEqual(['email', 'first_name']);
    expect(record.tables[1]!.copyOnly).toBe(true);
    expect(record.totals).toEqual({
      tablesProcessed: 2,
      rowsProcessed: 150,
      rowsWritten: 150,
    });
  });

  it('should not include passwords in audit record', () => {
    const record = buildAuditRecord({
      config: makeConfig(),
      result: makeResult(),
      durationMs: 100,
    });

    const json = JSON.stringify(record);
    expect(json).not.toContain('secret-should-not-appear');
  });

  it('should default syncSchema to false and concurrency to 1', () => {
    const record = buildAuditRecord({
      config: makeConfig(),
      result: makeResult(),
      durationMs: 100,
    });

    expect(record.options.syncSchema).toBe(false);
    expect(record.options.concurrency).toBe(1);
  });
});

describe('writeAuditLog', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `shinobidb-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true });
    }
  });

  function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
    return {
      timestamp: '2026-03-29T10:00:00.000Z',
      durationMs: 500,
      source: { type: 'mysql', host: 'src.host', database: 'src_db' },
      target: { type: 'mysql', host: 'tgt.host', database: 'tgt_db' },
      options: {
        syncSchema: false,
        concurrency: 1,
        deterministic: true,
        truncateTarget: true,
      },
      tables: [
        {
          schema: 'src_db',
          table: 'users',
          rowsProcessed: 10,
          rowsWritten: 10,
          copyOnly: false,
          maskedColumns: ['email'],
        },
      ],
      totals: { tablesProcessed: 1, rowsProcessed: 10, rowsWritten: 10 },
      ...overrides,
    };
  }

  describe('JSON format', () => {
    it('should create a new JSON file with array of one record', async () => {
      const filePath = join(testDir, 'audit.json');
      const record = makeRecord();

      await writeAuditLog(filePath, record);

      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as AuditRecord[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.timestamp).toBe('2026-03-29T10:00:00.000Z');
      expect(parsed[0]!.totals.rowsProcessed).toBe(10);
    });

    it('should append to existing JSON array', async () => {
      const filePath = join(testDir, 'audit.json');

      await writeAuditLog(filePath, makeRecord({ durationMs: 100 }));
      await writeAuditLog(filePath, makeRecord({ durationMs: 200 }));

      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as AuditRecord[];
      expect(parsed).toHaveLength(2);
      expect(parsed[0]!.durationMs).toBe(100);
      expect(parsed[1]!.durationMs).toBe(200);
    });

    it('should create nested directories if needed', async () => {
      const filePath = join(testDir, 'nested', 'deep', 'audit.json');

      await writeAuditLog(filePath, makeRecord());

      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe('CSV format', () => {
    it('should create a new CSV file with headers and one row', async () => {
      const filePath = join(testDir, 'audit.csv');
      const record = makeRecord();

      await writeAuditLog(filePath, record);

      const content = await readFile(filePath, 'utf-8');
      const lines = content.trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('timestamp');
      expect(lines[0]).toContain('rows_processed');
      expect(lines[1]).toContain('2026-03-29T10:00:00.000Z');
      expect(lines[1]).toContain('10');
    });

    it('should append rows without repeating headers', async () => {
      const filePath = join(testDir, 'audit.csv');

      await writeAuditLog(filePath, makeRecord({ durationMs: 100 }));
      await writeAuditLog(filePath, makeRecord({ durationMs: 200 }));

      const content = await readFile(filePath, 'utf-8');
      const lines = content.trimEnd().split('\n');
      expect(lines).toHaveLength(3); // header + 2 rows
      expect(lines[1]).toContain('100');
      expect(lines[2]).toContain('200');
    });

    it('should escape CSV fields with commas', async () => {
      const filePath = join(testDir, 'audit.csv');
      const record = makeRecord({
        source: { type: 'mysql', host: 'host,with,commas', database: 'db' },
      });

      await writeAuditLog(filePath, record);

      const content = await readFile(filePath, 'utf-8');
      expect(content).toContain('"host,with,commas"');
    });
  });

  it('should default to JSON for unknown extensions', async () => {
    const filePath = join(testDir, 'audit.log');

    await writeAuditLog(filePath, makeRecord());

    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as AuditRecord[];
    expect(parsed).toHaveLength(1);
  });
});
