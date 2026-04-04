import type { DatabaseAdapter } from '../../db/types.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';
import type { SyncMaskTable } from '../types.js';
import { executeUpdateMask } from '../update-masker.js';

// Suppress log output during tests
jest.mock('../../shared/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    output: jest.fn(),
  },
}));

function createMockAdapter(
  tableRows: Record<string, Record<string, unknown>[][]>,
): DatabaseAdapter {
  return {
    connect: jest.fn(),
    getSchemas: jest.fn(),
    getTables: jest.fn(),
    getColumns: jest.fn(),
    getRowCount: jest.fn().mockResolvedValue(0),
    getForeignKeys: jest.fn(),
    readRows: jest.fn(
      async (
        schema: string,
        table: string,
        _batchSize: number,
        onBatch: (rows: Record<string, unknown>[]) => Promise<boolean | void>,
      ) => {
        const key = `${schema}.${table}`;
        const batches = tableRows[key] ?? [];
        for (const batch of batches) {
          await onBatch(batch);
        }
      },
    ),
    writeRows: jest.fn(),
    upsertRows: jest.fn(),
    updateRows: jest.fn(),
    truncateTable: jest.fn(),
    tableExists: jest.fn(),
    createTable: jest.fn(),
    destroy: jest.fn(),
  };
}

describe('executeUpdateMask', () => {
  const registry = createDefaultRegistry();

  it('should mask PII columns and call updateRows', async () => {
    const adapter = createMockAdapter({
      'testdb.users': [
        [
          { id: 1, email: 'alice@test.com', name: 'Alice' },
          { id: 2, email: 'bob@test.com', name: 'Bob' },
        ],
      ],
    });

    const tables: SyncMaskTable[] = [
      {
        schema: 'testdb',
        table: 'users',
        columns: [
          { name: 'email', strategy: 'hash_email' },
          { name: 'name', strategy: 'fake_name' },
        ],
        primaryKey: ['id'],
      },
    ];

    const result = await executeUpdateMask(adapter, tables, registry, {
      batchSize: 1000,
      deterministic: true,
      seed: 'test-seed',
      concurrency: 1,
    });

    expect(result.tablesMasked).toBe(1);
    expect(result.rowsMasked).toBe(2);

    // updateRows should have been called with masked data
    expect(adapter.updateRows).toHaveBeenCalledTimes(1);
    const updateCall = (adapter.updateRows as jest.Mock).mock.calls[0]!;
    expect(updateCall[0]).toBe('testdb');
    expect(updateCall[1]).toBe('users');

    const updates = updateCall[2] as Record<string, unknown>[];
    expect(updates).toHaveLength(2);

    // PK should be preserved
    expect(updates[0]!['id']).toBe(1);
    expect(updates[1]!['id']).toBe(2);

    // Email and name should be masked (different from original)
    expect(updates[0]!['email']).not.toBe('alice@test.com');
    expect(updates[1]!['email']).not.toBe('bob@test.com');
    expect(updates[0]!['name']).not.toBe('Alice');
  });

  it('should throw if table has no primary key', async () => {
    const adapter = createMockAdapter({});

    const tables: SyncMaskTable[] = [
      {
        schema: 'testdb',
        table: 'logs',
        columns: [{ name: 'message', strategy: 'redact' }],
        primaryKey: [],
      },
    ];

    await expect(
      executeUpdateMask(adapter, tables, registry, {
        batchSize: 1000,
        deterministic: false,
        concurrency: 1,
      }),
    ).rejects.toThrow('Primary key is required');
  });

  it('should handle empty tables', async () => {
    const adapter = createMockAdapter({
      'testdb.users': [[]],
    });

    const tables: SyncMaskTable[] = [
      {
        schema: 'testdb',
        table: 'users',
        columns: [{ name: 'email', strategy: 'hash_email' }],
        primaryKey: ['id'],
      },
    ];

    const result = await executeUpdateMask(adapter, tables, registry, {
      batchSize: 1000,
      deterministic: false,
      concurrency: 1,
    });

    expect(result.rowsMasked).toBe(0);
    expect(adapter.updateRows).not.toHaveBeenCalled();
  });

  it('should handle multiple batches', async () => {
    const adapter = createMockAdapter({
      'testdb.users': [[{ id: 1, email: 'a@test.com' }], [{ id: 2, email: 'b@test.com' }]],
    });

    const tables: SyncMaskTable[] = [
      {
        schema: 'testdb',
        table: 'users',
        columns: [{ name: 'email', strategy: 'hash_email' }],
        primaryKey: ['id'],
      },
    ];

    const result = await executeUpdateMask(adapter, tables, registry, {
      batchSize: 1,
      deterministic: false,
      concurrency: 1,
    });

    expect(result.rowsMasked).toBe(2);
    expect(adapter.updateRows).toHaveBeenCalledTimes(2);
  });

  it('should produce deterministic results using PK-based seed', async () => {
    const makeAdapter = () =>
      createMockAdapter({
        'testdb.users': [[{ id: 42, email: 'test@example.com' }]],
      });

    const tables: SyncMaskTable[] = [
      {
        schema: 'testdb',
        table: 'users',
        columns: [{ name: 'email', strategy: 'hash_email' }],
        primaryKey: ['id'],
      },
    ];

    const adapter1 = makeAdapter();
    const adapter2 = makeAdapter();

    await executeUpdateMask(adapter1, tables, registry, {
      batchSize: 1000,
      deterministic: true,
      seed: 'same-seed',
      concurrency: 1,
    });

    await executeUpdateMask(adapter2, tables, registry, {
      batchSize: 1000,
      deterministic: true,
      seed: 'same-seed',
      concurrency: 1,
    });

    const result1 = (adapter1.updateRows as jest.Mock).mock.calls[0]![2] as Record<
      string,
      unknown
    >[];
    const result2 = (adapter2.updateRows as jest.Mock).mock.calls[0]![2] as Record<
      string,
      unknown
    >[];

    expect(result1[0]!['email']).toBe(result2[0]!['email']);
  });

  it('should skip columns not present in row', async () => {
    const adapter = createMockAdapter({
      'testdb.users': [[{ id: 1, email: 'a@test.com' }]],
    });

    const tables: SyncMaskTable[] = [
      {
        schema: 'testdb',
        table: 'users',
        columns: [
          { name: 'email', strategy: 'hash_email' },
          { name: 'phone', strategy: 'fake_phone' }, // not in row
        ],
        primaryKey: ['id'],
      },
    ];

    const result = await executeUpdateMask(adapter, tables, registry, {
      batchSize: 1000,
      deterministic: false,
      concurrency: 1,
    });

    expect(result.rowsMasked).toBe(1);
    const updates = (adapter.updateRows as jest.Mock).mock.calls[0]![2] as Record<
      string,
      unknown
    >[];
    expect(updates[0]).toHaveProperty('email');
    expect(updates[0]).not.toHaveProperty('phone');
  });
});
