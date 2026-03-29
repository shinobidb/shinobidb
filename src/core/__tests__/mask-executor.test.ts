import type { ShinobiConfig } from '../../config/types.js';
import type { ColumnInfo, DatabaseAdapter } from '../../db/types.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';
import { executeMask, executeDryRun } from '../mask-executor.js';
import * as syncStateModule from '../sync-state.js';

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
    upsertRows: jest.fn(),
    truncateTable: jest.fn(),
    tableExists: jest.fn().mockResolvedValue(true),
    createTable: jest.fn(),
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
    expect(result.tableDetails).toHaveLength(1);
    expect(result.tableDetails[0]).toEqual({
      schema: 'test_db',
      table: 'users',
      rowsProcessed: 2,
      rowsWritten: 2,
      copyOnly: false,
      maskedColumns: ['email', 'first_name'],
    });

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

  it('should use target.database as schema when source and target schemas differ', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'test@example.com', first_name: 'Test' }]]);
    const target = createMockAdapter();
    const config = makeConfig({
      source: {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: '',
        database: 'source_db',
      },
      target: {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: '',
        database: 'target_db',
      },
      tables: [
        {
          schema: 'source_db',
          table: 'users',
          columns: [
            { name: 'email', strategy: 'hash_email' },
            { name: 'first_name', strategy: 'fake_first_name' },
          ],
        },
      ],
    });

    await executeMask(source, target, config, registry);

    // Source should read from source_db
    expect(source.readRows).toHaveBeenCalledWith(
      'source_db',
      'users',
      expect.any(Number),
      expect.any(Function),
    );

    // Target should write to target_db, not source_db
    expect(target.truncateTable).toHaveBeenCalledWith('target_db', 'users');
    expect(target.writeRows).toHaveBeenCalledWith('target_db', 'users', expect.any(Array));
  });

  it('should fall back to source schema when target.database is not set', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'test@example.com', first_name: 'Test' }]]);
    const target = createMockAdapter();
    const config = makeConfig();
    // config has no database set on target

    await executeMask(source, target, config, registry);

    // Should use the table's schema (test_db) for both source and target
    expect(source.readRows).toHaveBeenCalledWith(
      'test_db',
      'users',
      expect.any(Number),
      expect.any(Function),
    );
    expect(target.truncateTable).toHaveBeenCalledWith('test_db', 'users');
    expect(target.writeRows).toHaveBeenCalledWith('test_db', 'users', expect.any(Array));
  });

  it('should use tableConfig.schema for postgres even when target.database is set', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'test@example.com', first_name: 'Test' }]]);
    const target = createMockAdapter();
    const config = makeConfig({
      source: {
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        user: 'postgres',
        password: '',
        database: 'source_db',
      },
      target: {
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        user: 'postgres',
        password: '',
        database: 'target_db',
      },
      tables: [
        {
          schema: 'public',
          table: 'users',
          columns: [
            { name: 'email', strategy: 'hash_email' },
            { name: 'first_name', strategy: 'fake_first_name' },
          ],
        },
      ],
    });

    await executeMask(source, target, config, registry);

    // PostgreSQL: should use 'public' schema, NOT 'target_db' database name
    expect(target.truncateTable).toHaveBeenCalledWith('public', 'users');
    expect(target.writeRows).toHaveBeenCalledWith('public', 'users', expect.any(Array));
  });

  it('should copy rows without masking for copyOnly tables', async () => {
    const sourceRows = [
      [
        { id: 1, name: 'Tokyo', code: 13 },
        { id: 2, name: 'Osaka', code: 27 },
      ],
    ];

    const source = createMockAdapter(sourceRows);
    const target = createMockAdapter();
    const config = makeConfig({
      tables: [
        {
          schema: 'test_db',
          table: 'prefectures',
          columns: [],
          copyOnly: true,
        },
      ],
    });

    const result = await executeMask(source, target, config, registry);

    expect(result.tablesProcessed).toBe(1);
    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsWritten).toBe(2);
    expect(result.tableDetails[0]).toEqual({
      schema: 'test_db',
      table: 'prefectures',
      rowsProcessed: 2,
      rowsWritten: 2,
      copyOnly: true,
      maskedColumns: [],
    });

    const writtenRows = (target.writeRows as jest.Mock).mock.calls[0]![2] as Record<
      string,
      unknown
    >[];
    // Data should be copied as-is, no masking
    expect(writtenRows[0]).toEqual({ id: 1, name: 'Tokyo', code: 13 });
    expect(writtenRows[1]).toEqual({ id: 2, name: 'Osaka', code: 27 });
  });

  it('should handle mix of copyOnly and masked tables', async () => {
    let callCount = 0;
    const source = createMockAdapter();
    (source.readRows as jest.Mock).mockImplementation(
      async (
        _s: string,
        _t: string,
        _b: number,
        onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
      ) => {
        if (callCount === 0) {
          await onBatch([{ id: 1, email: 'alice@example.com', first_name: 'Alice' }]);
        } else {
          await onBatch([{ id: 1, name: 'Tokyo', code: 13 }]);
        }
        callCount++;
      },
    );

    const target = createMockAdapter();
    const config = makeConfig({
      tables: [
        {
          schema: 'test_db',
          table: 'users',
          columns: [{ name: 'email', strategy: 'hash_email' }],
        },
        {
          schema: 'test_db',
          table: 'prefectures',
          columns: [],
          copyOnly: true,
        },
      ],
    });

    const result = await executeMask(source, target, config, registry);

    expect(result.tablesProcessed).toBe(2);
    expect(result.rowsWritten).toBe(2);

    // First table: masked
    const maskedRows = (target.writeRows as jest.Mock).mock.calls[0]![2] as Record<
      string,
      unknown
    >[];
    expect(maskedRows[0]!.email).not.toBe('alice@example.com');

    // Second table: copied as-is
    const copiedRows = (target.writeRows as jest.Mock).mock.calls[1]![2] as Record<
      string,
      unknown
    >[];
    expect(copiedRows[0]).toEqual({ id: 1, name: 'Tokyo', code: 13 });
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

describe('executeDryRun', () => {
  const registry = createDefaultRegistry();

  function createDryRunAdapter(rows: Record<string, unknown>[][], rowCount = 100): DatabaseAdapter {
    return {
      connect: jest.fn(),
      getSchemas: jest.fn(),
      getTables: jest.fn(),
      getColumns: jest.fn(),
      getRowCount: jest.fn().mockResolvedValue(rowCount),
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
      upsertRows: jest.fn(),
      truncateTable: jest.fn(),
      tableExists: jest.fn().mockResolvedValue(true),
      createTable: jest.fn(),
      destroy: jest.fn(),
    };
  }

  it('should return before/after samples without writing', async () => {
    const source = createDryRunAdapter([
      [
        { id: 1, email: 'alice@example.com', first_name: 'Alice' },
        { id: 2, email: 'bob@example.com', first_name: 'Bob' },
      ],
    ]);
    const config = makeConfig();

    const result = await executeDryRun(source, config, registry, 3);

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.schema).toBe('test_db');
    expect(result.tables[0]!.table).toBe('users');
    expect(result.tables[0]!.copyOnly).toBe(false);
    expect(result.tables[0]!.samples).toHaveLength(2);

    // before should have original values
    expect(result.tables[0]!.samples[0]!.before.email).toBe('alice@example.com');
    // after should have masked values
    expect(result.tables[0]!.samples[0]!.after.email).not.toBe('alice@example.com');

    // No writes should have happened
    expect(source.writeRows).not.toHaveBeenCalled();
  });

  it('should limit samples to sampleRows', async () => {
    const source = createDryRunAdapter([
      [
        { id: 1, email: 'a@test.com', first_name: 'A' },
        { id: 2, email: 'b@test.com', first_name: 'B' },
        { id: 3, email: 'c@test.com', first_name: 'C' },
        { id: 4, email: 'd@test.com', first_name: 'D' },
        { id: 5, email: 'e@test.com', first_name: 'E' },
      ],
    ]);
    const config = makeConfig();

    const result = await executeDryRun(source, config, registry, 2);

    expect(result.tables[0]!.samples).toHaveLength(2);
  });

  it('should collect all samples when sampleRows is 0', async () => {
    const source = createDryRunAdapter([
      [
        { id: 1, email: 'a@test.com', first_name: 'A' },
        { id: 2, email: 'b@test.com', first_name: 'B' },
        { id: 3, email: 'c@test.com', first_name: 'C' },
      ],
    ]);
    const config = makeConfig();

    const result = await executeDryRun(source, config, registry, 0);

    expect(result.tables[0]!.samples).toHaveLength(3);
  });

  it('should show copyOnly tables without samples', async () => {
    const source = createDryRunAdapter([], 50);
    const config = makeConfig({
      tables: [
        {
          schema: 'test_db',
          table: 'prefectures',
          columns: [],
          copyOnly: true,
        },
      ],
    });

    const result = await executeDryRun(source, config, registry);

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.copyOnly).toBe(true);
    expect(result.tables[0]!.rowCount).toBe(50);
    expect(result.tables[0]!.samples).toHaveLength(0);
  });

  it('should report totalRows across all tables', async () => {
    let callCount = 0;
    const source = createDryRunAdapter([]);
    (source.getRowCount as jest.Mock).mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount === 1 ? 100 : 50);
    });
    (source.readRows as jest.Mock).mockImplementation(
      async (
        _s: string,
        _t: string,
        _b: number,
        onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
      ) => {
        await onBatch([{ id: 1, email: 'a@test.com', first_name: 'A' }]);
      },
    );

    const config = makeConfig({
      tables: [
        {
          schema: 'test_db',
          table: 'users',
          columns: [{ name: 'email', strategy: 'hash_email' }],
        },
        {
          schema: 'test_db',
          table: 'prefectures',
          columns: [],
          copyOnly: true,
        },
      ],
    });

    const result = await executeDryRun(source, config, registry);

    expect(result.totalRows).toBe(150);
    expect(result.tables).toHaveLength(2);
  });
});

describe('executeMask syncSchema', () => {
  const registry = createDefaultRegistry();

  it('should throw when target table does not exist and syncSchema is false', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'test@example.com', first_name: 'Test' }]]);
    const target = createMockAdapter();
    (target.tableExists as jest.Mock).mockResolvedValue(false);

    const config = makeConfig();

    await expect(executeMask(source, target, config, registry)).rejects.toThrow('TABLE_NOT_FOUND');
  });

  it('should auto-create table when syncSchema is true and table does not exist', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'test@example.com', first_name: 'Test' }]]);
    (source.getColumns as jest.Mock).mockResolvedValue([
      {
        name: 'id',
        dataType: 'int',
        nullable: false,
        isPrimaryKey: true,
        isForeignKey: false,
        defaultValue: null,
        comment: null,
      },
      {
        name: 'email',
        dataType: 'varchar',
        nullable: true,
        isPrimaryKey: false,
        isForeignKey: false,
        defaultValue: null,
        comment: null,
      },
    ]);
    const target = createMockAdapter();
    (target.tableExists as jest.Mock).mockResolvedValue(false);

    const config = makeConfig();

    const result = await executeMask(source, target, config, registry, { syncSchema: true });

    expect(target.createTable).toHaveBeenCalledWith('test_db', 'users', expect.any(Array));
    expect(result.tablesProcessed).toBe(1);
    expect(result.rowsWritten).toBe(1);
  });

  it('should not truncate newly created tables', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'test@example.com', first_name: 'Test' }]]);
    const target = createMockAdapter();
    (target.tableExists as jest.Mock).mockResolvedValue(false);

    const config = makeConfig();

    await executeMask(source, target, config, registry, { syncSchema: true });

    expect(target.truncateTable).not.toHaveBeenCalled();
  });

  it('should still truncate existing tables', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'test@example.com', first_name: 'Test' }]]);
    const target = createMockAdapter();
    (target.tableExists as jest.Mock).mockResolvedValue(true);

    const config = makeConfig();

    await executeMask(source, target, config, registry, { syncSchema: true });

    expect(target.truncateTable).toHaveBeenCalledWith('test_db', 'users');
    expect(target.createTable).not.toHaveBeenCalled();
  });
});

describe('executeMask concurrency', () => {
  const registry = createDefaultRegistry();

  it('should process multiple tables in parallel with concurrency > 1', async () => {
    const executionOrder: string[] = [];
    const source = createMockAdapter();
    (source.readRows as jest.Mock).mockImplementation(
      async (
        _s: string,
        table: string,
        _b: number,
        onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
      ) => {
        executionOrder.push(`start:${table}`);
        await onBatch([{ id: 1, email: `test@${table}.com`, first_name: 'Test' }]);
        executionOrder.push(`end:${table}`);
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
          table: 'orders',
          columns: [{ name: 'email', strategy: 'hash_email' }],
        },
      ],
    });

    const result = await executeMask(source, target, config, registry, { concurrency: 4 });

    expect(result.tablesProcessed).toBe(2);
    expect(result.rowsWritten).toBe(2);
  });

  it('should default to sequential processing (concurrency 1)', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'a@test.com', first_name: 'A' }]]);
    const target = createMockAdapter();
    const config = makeConfig();

    const result = await executeMask(source, target, config, registry);

    expect(result.tablesProcessed).toBe(1);
    expect(result.rowsWritten).toBe(1);
  });
});

describe('executeMask progress', () => {
  const registry = createDefaultRegistry();

  it('should call onProgress callback during execution', async () => {
    const source = createMockAdapter([
      [
        { id: 1, email: 'a@test.com', first_name: 'A' },
        { id: 2, email: 'b@test.com', first_name: 'B' },
      ],
    ]);
    (source.getRowCount as jest.Mock).mockResolvedValue(2);

    const target = createMockAdapter();
    const config = makeConfig();
    const progressCalls: Array<{ processedRows: number; currentTable: string }> = [];

    await executeMask(source, target, config, registry, {
      onProgress: (info) => {
        progressCalls.push({
          processedRows: info.processedRows,
          currentTable: info.currentTable,
        });
      },
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    const lastCall = progressCalls[progressCalls.length - 1]!;
    expect(lastCall.processedRows).toBe(2);
    expect(lastCall.currentTable).toBe('test_db.users');
  });

  it('should report total estimated rows', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'a@test.com', first_name: 'A' }]]);
    (source.getRowCount as jest.Mock).mockResolvedValue(100);

    const target = createMockAdapter();
    const config = makeConfig();
    let totalRows = 0;

    await executeMask(source, target, config, registry, {
      onProgress: (info) => {
        totalRows = info.totalRows;
      },
    });

    expect(totalRows).toBe(100);
  });
});

describe('executeMask incremental sync', () => {
  const registry = createDefaultRegistry();

  const idColumn: ColumnInfo = {
    name: 'id',
    dataType: 'int',
    nullable: false,
    isPrimaryKey: true,
    isForeignKey: false,
    defaultValue: null,
    comment: null,
  };

  const emailColumn: ColumnInfo = {
    name: 'email',
    dataType: 'varchar',
    nullable: true,
    isPrimaryKey: false,
    isForeignKey: false,
    defaultValue: null,
    comment: null,
  };

  const updatedAtColumn: ColumnInfo = {
    name: 'updated_at',
    dataType: 'datetime',
    nullable: false,
    isPrimaryKey: false,
    isForeignKey: false,
    defaultValue: null,
    comment: null,
  };

  beforeEach(() => {
    jest.spyOn(syncStateModule, 'loadSyncState').mockResolvedValue(null);
    jest.spyOn(syncStateModule, 'saveSyncState').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should do full copy on first run for incremental table (no state)', async () => {
    const source = createMockAdapter([
      [
        { id: 1, email: 'a@test.com', first_name: 'Alice', updated_at: '2026-03-28T00:00:00Z' },
        { id: 2, email: 'b@test.com', first_name: 'Bob', updated_at: '2026-03-29T00:00:00Z' },
      ],
    ]);
    (source.getColumns as jest.Mock).mockResolvedValue([idColumn, emailColumn, updatedAtColumn]);

    const target = createMockAdapter();
    (target.getColumns as jest.Mock).mockResolvedValue([idColumn, emailColumn, updatedAtColumn]);
    const config = makeConfig({
      tables: [
        {
          schema: 'test_db',
          table: 'users',
          columns: [{ name: 'email', strategy: 'hash_email' }],
          incremental: { strategy: 'timestamp', column: 'updated_at' },
        },
      ],
    });

    const result = await executeMask(source, target, config, registry);

    expect(result.rowsProcessed).toBe(2);
    expect(target.writeRows).toHaveBeenCalled();
    expect(target.upsertRows).not.toHaveBeenCalled();
    expect(syncStateModule.saveSyncState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tables: expect.objectContaining({
          'test_db.users': expect.objectContaining({
            strategy: 'timestamp',
            cursor: '2026-03-29T00:00:00Z',
          }),
        }),
      }),
    );
  });

  it('should use filter and upsert on subsequent runs with existing state', async () => {
    const existingState: syncStateModule.SyncState = {
      version: 1,
      sourceFingerprint: syncStateModule.createSourceFingerprint({
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: '',
      }),
      tables: {
        'test_db.users': {
          strategy: 'timestamp',
          cursor: '2026-03-28T00:00:00Z',
          lastSyncedAt: '2026-03-28T12:00:00Z',
          rowsSynced: 100,
        },
      },
    };
    (syncStateModule.loadSyncState as jest.Mock).mockResolvedValue(existingState);

    const incrementalRows = [
      { id: 3, email: 'c@test.com', first_name: 'Charlie', updated_at: '2026-03-29T00:00:00Z' },
    ];

    const source: DatabaseAdapter = {
      connect: jest.fn(),
      getSchemas: jest.fn(),
      getTables: jest.fn(),
      getColumns: jest.fn().mockResolvedValue([idColumn, emailColumn, updatedAtColumn]),
      getRowCount: jest.fn().mockResolvedValue(3),
      getForeignKeys: jest.fn(),
      readRows: jest.fn(
        async (
          _schema: string,
          _table: string,
          _batchSize: number,
          onBatch: (rows: Record<string, unknown>[]) => Promise<boolean | void>,
          _filter?: unknown,
        ) => {
          await onBatch(incrementalRows);
        },
      ),
      writeRows: jest.fn(),
      upsertRows: jest.fn(),
      truncateTable: jest.fn(),
      tableExists: jest.fn().mockResolvedValue(true),
      createTable: jest.fn(),
      destroy: jest.fn(),
    };

    const target = createMockAdapter();
    (target.getColumns as jest.Mock).mockResolvedValue([idColumn, emailColumn, updatedAtColumn]);
    const config = makeConfig({
      tables: [
        {
          schema: 'test_db',
          table: 'users',
          columns: [{ name: 'email', strategy: 'hash_email' }],
          incremental: { strategy: 'timestamp', column: 'updated_at' },
        },
      ],
    });

    const result = await executeMask(source, target, config, registry);

    expect(result.rowsProcessed).toBe(1);
    expect(target.upsertRows).toHaveBeenCalled();
    expect(target.writeRows).not.toHaveBeenCalled();
    // Should not truncate incremental table with existing state
    expect(target.truncateTable).not.toHaveBeenCalled();
  });

  it('should do full copy when --full-refresh is set', async () => {
    const existingState: syncStateModule.SyncState = {
      version: 1,
      sourceFingerprint: syncStateModule.createSourceFingerprint({
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: '',
      }),
      tables: {
        'test_db.users': {
          strategy: 'timestamp',
          cursor: '2026-03-28T00:00:00Z',
          lastSyncedAt: '2026-03-28T12:00:00Z',
          rowsSynced: 100,
        },
      },
    };
    (syncStateModule.loadSyncState as jest.Mock).mockResolvedValue(existingState);

    const source = createMockAdapter([
      [{ id: 1, email: 'a@test.com', first_name: 'Alice', updated_at: '2026-03-29T00:00:00Z' }],
    ]);
    (source.getColumns as jest.Mock).mockResolvedValue([idColumn, emailColumn, updatedAtColumn]);

    const target = createMockAdapter();
    (target.getColumns as jest.Mock).mockResolvedValue([idColumn, emailColumn, updatedAtColumn]);
    const config = makeConfig({
      tables: [
        {
          schema: 'test_db',
          table: 'users',
          columns: [{ name: 'email', strategy: 'hash_email' }],
          incremental: { strategy: 'timestamp', column: 'updated_at' },
        },
      ],
    });

    const result = await executeMask(source, target, config, registry, { fullRefresh: true });

    expect(result.rowsProcessed).toBe(1);
    expect(target.writeRows).toHaveBeenCalled();
    expect(target.upsertRows).not.toHaveBeenCalled();
  });

  it('should throw when incremental table has no primary key', async () => {
    const noPkColumn: ColumnInfo = {
      ...emailColumn,
      isPrimaryKey: false,
    };
    const source = createMockAdapter([]);
    (source.getColumns as jest.Mock).mockResolvedValue([noPkColumn]);

    const target = createMockAdapter();
    const config = makeConfig({
      tables: [
        {
          schema: 'test_db',
          table: 'users',
          columns: [{ name: 'email', strategy: 'hash_email' }],
          incremental: { strategy: 'cursor', column: 'id' },
        },
      ],
    });

    await expect(executeMask(source, target, config, registry)).rejects.toThrow(
      'INCREMENTAL_NO_PK',
    );
  });

  it('should not save sync state for non-incremental tables', async () => {
    const source = createMockAdapter([[{ id: 1, email: 'a@test.com', first_name: 'Alice' }]]);
    const target = createMockAdapter();
    const config = makeConfig();

    await executeMask(source, target, config, registry);

    expect(syncStateModule.saveSyncState).not.toHaveBeenCalled();
  });
});
