import type { ColumnInfo, DatabaseAdapter, ForeignKeyInfo } from '../../db/types.js';
import type { PiiDetectionResult, PiiDetector } from '../../detection/types.js';
import { scan } from '../scanner.js';

function createMockAdapter(
  schemas: string[] = ['test_db'],
  tablesBySchema: Record<string, string[]> = { test_db: ['users', 'orders'] },
  columnsByTable: Record<string, ColumnInfo[]> = {},
): DatabaseAdapter {
  const defaultColumns: ColumnInfo[] = [
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
    {
      name: 'status',
      dataType: 'varchar',
      nullable: true,
      isPrimaryKey: false,
      isForeignKey: false,
      defaultValue: null,
      comment: null,
    },
  ];

  return {
    connect: jest.fn(),
    getSchemas: jest.fn().mockResolvedValue(schemas),
    getTables: jest
      .fn()
      .mockImplementation((schema: string) => Promise.resolve(tablesBySchema[schema] ?? [])),
    getColumns: jest
      .fn()
      .mockImplementation((_schema: string, table: string) =>
        Promise.resolve(columnsByTable[table] ?? defaultColumns),
      ),
    getForeignKeys: jest.fn().mockResolvedValue([] as ForeignKeyInfo[]),
    getRowCount: jest.fn().mockResolvedValue(100),
    readRows: jest.fn(),
    writeRows: jest.fn(),
    upsertRows: jest.fn(),
    truncateTable: jest.fn(),
    tableExists: jest.fn(),
    createTable: jest.fn(),
    destroy: jest.fn(),
  };
}

function createMockDetector(results: PiiDetectionResult[] = []): PiiDetector {
  return {
    detect: jest.fn().mockResolvedValue(results),
  };
}

describe('scan', () => {
  it('should scan all schemas and tables by default', async () => {
    const adapter = createMockAdapter();
    const detector = createMockDetector();

    const result = await scan(adapter, [detector]);

    expect(adapter.getSchemas).toHaveBeenCalled();
    expect(adapter.getTables).toHaveBeenCalledWith('test_db');
    expect(result.tablesScanned).toBe(2);
  });

  it('should count total columns scanned', async () => {
    const adapter = createMockAdapter();
    const detector = createMockDetector();

    const result = await scan(adapter, [detector]);

    // 2 tables * 3 columns each = 6
    expect(result.columnsScanned).toBe(6);
  });

  it('should filter schemas when specified', async () => {
    const adapter = createMockAdapter(['db1', 'db2'], { db1: ['t1'], db2: ['t2'] });
    const detector = createMockDetector();

    const result = await scan(adapter, [detector], { schemas: ['db1'] });

    expect(adapter.getSchemas).not.toHaveBeenCalled();
    expect(adapter.getTables).toHaveBeenCalledWith('db1');
    expect(adapter.getTables).not.toHaveBeenCalledWith('db2');
    expect(result.tablesScanned).toBe(1);
  });

  it('should filter tables when specified', async () => {
    const adapter = createMockAdapter(['test_db'], { test_db: ['users', 'orders', 'products'] });
    const detector = createMockDetector();

    const result = await scan(adapter, [detector], { tables: ['users', 'orders'] });

    expect(result.tablesScanned).toBe(2);
    expect(adapter.getColumns).toHaveBeenCalledWith('test_db', 'users');
    expect(adapter.getColumns).toHaveBeenCalledWith('test_db', 'orders');
    expect(adapter.getColumns).not.toHaveBeenCalledWith('test_db', 'products');
  });

  it('should pass tables to detectors', async () => {
    const adapter = createMockAdapter();
    const detector = createMockDetector();

    await scan(adapter, [detector]);

    expect(detector.detect).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          schema: 'test_db',
          name: 'users',
          columns: expect.any(Array),
        }),
      ]),
    );
  });

  it('should aggregate results from multiple detectors', async () => {
    const adapter = createMockAdapter();
    const detector1 = createMockDetector([
      {
        schema: 'test_db',
        table: 'users',
        column: 'email',
        category: 'email',
        confidence: 0.95,
        reasoning: 'pattern match',
        suggestedMaskingStrategy: 'hash_email',
      },
    ]);
    const detector2 = createMockDetector([
      {
        schema: 'test_db',
        table: 'users',
        column: 'phone',
        category: 'phone',
        confidence: 0.9,
        reasoning: 'pattern match',
        suggestedMaskingStrategy: 'fake_phone',
      },
    ]);

    const result = await scan(adapter, [detector1, detector2]);

    expect(result.detections).toHaveLength(2);
    expect(result.detections[0]!.column).toBe('email');
    expect(result.detections[1]!.column).toBe('phone');
  });

  it('should return empty detections when no PII found', async () => {
    const adapter = createMockAdapter(
      ['test_db'],
      { test_db: ['settings'] },
      {
        settings: [
          {
            name: 'key',
            dataType: 'varchar',
            nullable: false,
            isPrimaryKey: true,
            isForeignKey: false,
            defaultValue: null,
            comment: null,
          },
        ],
      },
    );
    const detector = createMockDetector([]);

    const result = await scan(adapter, [detector]);

    expect(result.detections).toHaveLength(0);
    expect(result.tablesScanned).toBe(1);
  });

  it('should handle empty database', async () => {
    const adapter = createMockAdapter(['test_db'], { test_db: [] });
    const detector = createMockDetector();

    const result = await scan(adapter, [detector]);

    expect(result.tablesScanned).toBe(0);
    expect(result.columnsScanned).toBe(0);
    expect(result.detections).toHaveLength(0);
  });

  it('should fetch columns, foreign keys, and row count for each table', async () => {
    const adapter = createMockAdapter();
    const detector = createMockDetector();

    await scan(adapter, [detector]);

    expect(adapter.getColumns).toHaveBeenCalledTimes(2);
    expect(adapter.getForeignKeys).toHaveBeenCalledTimes(2);
    expect(adapter.getRowCount).toHaveBeenCalledTimes(2);
  });
});
