import type { ShinobiConfig } from '../../config/types.js';
import type { DatabaseAdapter } from '../../db/types.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';
import { executeMask } from '../mask-executor.js';

function createMockAdapter(rows: Record<string, unknown>[][] = []): DatabaseAdapter {
  return {
    connect: jest.fn(),
    getSchemas: jest.fn(),
    getTables: jest.fn(),
    getColumns: jest.fn(),
    getRowCount: jest.fn(),
    getForeignKeys: jest.fn(),
    readRows: jest.fn(
      async (
        _schema: string,
        _table: string,
        _batchSize: number,
        onBatch: (rows: Record<string, unknown>[]) => Promise<boolean | void>,
      ) => {
        for (const batch of rows) {
          await onBatch(batch);
        }
      },
    ),
    writeRows: jest.fn(),
    truncateTable: jest.fn(),
    destroy: jest.fn(),
  };
}

function makeConfig(overrides: Partial<ShinobiConfig> = {}): ShinobiConfig {
  return {
    version: '1',
    source: {
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: '',
    },
    target: {
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: '',
    },
    options: {
      batchSize: 100,
      deterministic: true,
      seed: 'test-seed',
      truncateTarget: true,
    },
    tables: [
      {
        schema: 'test_db',
        table: 'users',
        columns: [
          { name: 'email', strategy: 'hash_email' },
          { name: 'first_name', strategy: 'fake_first_name' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('executeMask', () => {
  const registry = createDefaultRegistry();

  it('should process rows and write masked data', async () => {
    const sourceRows = [
      [
        { id: 1, email: 'alice@example.com', first_name: 'Alice', status: 'active' },
        { id: 2, email: 'bob@example.com', first_name: 'Bob', status: 'inactive' },
      ],
    ];

    const source = createMockAdapter(sourceRows);
    const target = createMockAdapter();
    const config = makeConfig();

    const result = await executeMask(source, target, config, registry);

    expect(result.tablesProcessed).toBe(1);
    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsWritten).toBe(2);

    expect(target.truncateTable).toHaveBeenCalledWith('test_db', 'users');
    expect(target.writeRows).toHaveBeenCalledTimes(1);

    const writtenRows = (target.writeRows as jest.Mock).mock.calls[0]![2] as Record<
      string,
      unknown
    >[];
    expect(writtenRows).toHaveLength(2);

    // email should be masked (not original)
    expect(writtenRows[0]!.email).not.toBe('alice@example.com');
    expect(writtenRows[0]!.email as string).toContain('@example.com');

    // first_name should be masked
    expect(writtenRows[0]!.first_name).not.toBe('Alice');

    // non-masked columns should be preserved
    expect(writtenRows[0]!.id).toBe(1);
    expect(writtenRows[0]!.status).toBe('active');
  });

  it('should skip truncate when truncateTarget is false', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'test@example.com', first_name: 'Test' }]]);
    const target = createMockAdapter();
    const config = makeConfig({
      options: {
        batchSize: 100,
        deterministic: true,
        seed: 'test',
        truncateTarget: false,
      },
    });

    await executeMask(source, target, config, registry);

    expect(target.truncateTable).not.toHaveBeenCalled();
  });

  it('should handle multiple batches', async () => {
    const sourceRows = [
      [{ id: 1, email: 'a@test.com', first_name: 'A' }],
      [{ id: 2, email: 'b@test.com', first_name: 'B' }],
    ];

    const source = createMockAdapter(sourceRows);
    const target = createMockAdapter();
    const config = makeConfig();

    const result = await executeMask(source, target, config, registry);

    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsWritten).toBe(2);
    expect(target.writeRows).toHaveBeenCalledTimes(2);
  });

  it('should handle multiple tables', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'a@test.com', first_name: 'A' }]]);
    // Reset readRows to return data for each table call
    let callCount = 0;
    (source.readRows as jest.Mock).mockImplementation(
      async (
        _s: string,
        _t: string,
        _b: number,
        onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
      ) => {
        await onBatch([
          { id: callCount + 1, email: `user${callCount}@test.com`, address: '123 St' },
        ]);
        callCount++;
      },
    );

    const target = createMockAdapter();
    const config = makeConfig({
      tables: [
        {
          schema: 'db',
          table: 'users',
          columns: [{ name: 'email', strategy: 'hash_email' }],
        },
        {
          schema: 'db',
          table: 'customers',
          columns: [{ name: 'address', strategy: 'fake_address' }],
        },
      ],
    });

    const result = await executeMask(source, target, config, registry);

    expect(result.tablesProcessed).toBe(2);
    expect(target.truncateTable).toHaveBeenCalledTimes(2);
  });

  it('should handle empty table (no rows)', async () => {
    const source = createMockAdapter([]);
    const target = createMockAdapter();
    const config = makeConfig();

    const result = await executeMask(source, target, config, registry);

    expect(result.tablesProcessed).toBe(1);
    expect(result.rowsProcessed).toBe(0);
    expect(result.rowsWritten).toBe(0);
    expect(target.writeRows).not.toHaveBeenCalled();
  });

  it('should produce deterministic output with same seed', async () => {
    const rows = [[{ id: 1, email: 'test@example.com', first_name: 'Test' }]];

    const target1 = createMockAdapter();
    const target2 = createMockAdapter();

    await executeMask(createMockAdapter(rows), target1, makeConfig(), registry);
    await executeMask(createMockAdapter(rows), target2, makeConfig(), registry);

    const written1 = (target1.writeRows as jest.Mock).mock.calls[0]![2];
    const written2 = (target2.writeRows as jest.Mock).mock.calls[0]![2];

    expect(written1).toEqual(written2);
  });

  it('should skip columns not present in row', async () => {
    const source = createMockAdapter([
      [{ id: 1, email: 'test@example.com' }], // no first_name column
    ]);
    const target = createMockAdapter();
    const config = makeConfig();

    const result = await executeMask(source, target, config, registry);

    expect(result.rowsProcessed).toBe(1);
    const writtenRows = (target.writeRows as jest.Mock).mock.calls[0]![2] as Record<
      string,
      unknown
    >[];
    expect(writtenRows[0]!.email).not.toBe('test@example.com');
    expect(writtenRows[0]!.first_name).toBeUndefined();
  });
});
