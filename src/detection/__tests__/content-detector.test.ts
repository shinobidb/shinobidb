import type { ColumnInfo, DatabaseAdapter, TableInfo } from '../../db/types.js';
import { ContentDetector } from '../detectors/content-detector.js';

function makeColumn(name: string, dataType = 'varchar(255)'): ColumnInfo {
  return {
    name,
    dataType,
    nullable: true,
    isPrimaryKey: false,
    isForeignKey: false,
    defaultValue: null,
    comment: null,
  };
}

function makeTable(schema: string, name: string, columns: ColumnInfo[], rowCount = 100): TableInfo {
  return { schema, name, columns, foreignKeys: [], estimatedRowCount: rowCount };
}

function mockAdapter(rows: Record<string, unknown>[]): DatabaseAdapter {
  return {
    readRows: jest.fn(async (_s, _t, _b, onBatch) => {
      await onBatch(rows);
    }),
  } as unknown as DatabaseAdapter;
}

describe('ContentDetector', () => {
  it('should detect email addresses in column values', async () => {
    const adapter = mockAdapter([
      { data: 'alice@example.com' },
      { data: 'bob@gmail.com' },
      { data: 'charlie@company.co.jp' },
    ]);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'users', [makeColumn('data')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(1);
    expect(results[0]!.category).toBe('email');
    expect(results[0]!.suggestedMaskingStrategy).toBe('hash_email');
    expect(results[0]!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(results[0]!.reasoning).toContain('3/3');
  });

  it('should detect phone numbers', async () => {
    const adapter = mockAdapter([
      { contact: '555-123-4567' },
      { contact: '(212) 555-0100' },
      { contact: '+1 800-555-1234' },
      { contact: 'N/A' },
    ]);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'contacts', [makeColumn('contact')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(1);
    expect(results[0]!.category).toBe('phone');
  });

  it('should detect IP addresses', async () => {
    const adapter = mockAdapter([
      { log: '192.168.1.1' },
      { log: '10.0.0.255' },
      { log: '172.16.0.1' },
    ]);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'access_log', [makeColumn('log')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(1);
    expect(results[0]!.category).toBe('ip_address');
    expect(results[0]!.suggestedMaskingStrategy).toBe('hash_ip');
  });

  it('should detect credit card numbers', async () => {
    const adapter = mockAdapter([
      { payment: '4111-1111-1111-1111' },
      { payment: '5500 0000 0000 0004' },
      { payment: '340000000000009' },
    ]);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'payments', [makeColumn('payment')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(1);
    expect(results[0]!.category).toBe('credit_card');
    expect(results[0]!.suggestedMaskingStrategy).toBe('redact');
  });

  it('should not detect PII when match ratio is below threshold', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      data: i === 0 ? 'alice@example.com' : `product-${i}`,
    }));
    const adapter = mockAdapter(rows);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'items', [makeColumn('data')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(0);
  });

  it('should skip primary key columns', async () => {
    const pkCol = makeColumn('id', 'int');
    pkCol.isPrimaryKey = true;
    const adapter = mockAdapter([{ id: 'alice@example.com' }]);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'users', [pkCol]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(0);
  });

  it('should skip foreign key columns', async () => {
    const fkCol = makeColumn('ref', 'varchar(255)');
    fkCol.isForeignKey = true;
    const adapter = mockAdapter([{ ref: 'alice@example.com' }]);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'orders', [fkCol]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(0);
  });

  it('should skip numeric data type columns', async () => {
    const adapter = mockAdapter([{ amount: '192.168.1.1' }]);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'orders', [makeColumn('amount', 'integer')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(0);
  });

  it('should skip non-string values', async () => {
    const adapter = mockAdapter([{ data: 12345 }, { data: null }, { data: true }]);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'misc', [makeColumn('data')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(0);
  });

  it('should handle empty tables gracefully', async () => {
    const adapter = mockAdapter([]);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'empty', [makeColumn('data')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(0);
  });

  it('should handle readRows errors gracefully', async () => {
    const adapter = {
      readRows: jest.fn(async () => {
        throw new Error('connection lost');
      }),
    } as unknown as DatabaseAdapter;
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'broken', [makeColumn('data')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(0);
  });

  it('should detect across multiple columns independently', async () => {
    const adapter = mockAdapter([
      { contact_info: 'alice@example.com', access_ip: '10.0.0.1' },
      { contact_info: 'bob@example.com', access_ip: '10.0.0.2' },
    ]);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'users', [makeColumn('contact_info'), makeColumn('access_ip')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(2);
    const categories = results.map((r) => r.category).sort();
    expect(categories).toEqual(['email', 'ip_address']);
  });

  it('should select the category with highest match ratio', async () => {
    // SSN pattern (123-45-6789) also partially matches phone
    // But more values match email, so email should win for that column
    const adapter = mockAdapter([
      { data: 'alice@example.com' },
      { data: 'bob@example.com' },
      { data: 'carol@example.com' },
    ]);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'users', [makeColumn('data')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(1);
    expect(results[0]!.category).toBe('email');
  });

  it('should cap confidence at 0.9', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      email: `user${i}@example.com`,
    }));
    const adapter = mockAdapter(rows);
    const detector = new ContentDetector(adapter, 100);
    const table = makeTable('db', 'users', [makeColumn('email')]);

    const results = await detector.detect([table]);

    expect(results).toHaveLength(1);
    expect(results[0]!.confidence).toBeLessThanOrEqual(0.9);
  });
});
