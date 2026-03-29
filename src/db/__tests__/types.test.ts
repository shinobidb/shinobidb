import type {
  ColumnInfo,
  DatabaseAdapter,
  ForeignKeyInfo,
  ReadFilter,
  TableInfo,
} from '../types.js';

describe('db types', () => {
  it('should allow constructing ColumnInfo', () => {
    const col: ColumnInfo = {
      name: 'email',
      dataType: 'varchar(255)',
      nullable: false,
      isPrimaryKey: false,
      isForeignKey: false,
      defaultValue: null,
      comment: null,
    };

    expect(col.name).toBe('email');
    expect(col.nullable).toBe(false);
  });

  it('should allow constructing ForeignKeyInfo', () => {
    const fk: ForeignKeyInfo = {
      column: 'user_id',
      referencedSchema: 'myapp',
      referencedTable: 'users',
      referencedColumn: 'id',
    };

    expect(fk.referencedTable).toBe('users');
  });

  it('should allow constructing TableInfo', () => {
    const table: TableInfo = {
      schema: 'myapp',
      name: 'users',
      columns: [],
      foreignKeys: [],
      estimatedRowCount: 1000,
    };

    expect(table.schema).toBe('myapp');
    expect(table.estimatedRowCount).toBe(1000);
  });

  it('should type-check DatabaseAdapter interface', () => {
    const mockAdapter: DatabaseAdapter = {
      connect: jest.fn(),
      getSchemas: jest.fn(),
      getTables: jest.fn(),
      getColumns: jest.fn(),
      getRowCount: jest.fn(),
      getForeignKeys: jest.fn(),
      readRows: jest.fn(),
      writeRows: jest.fn(),
      upsertRows: jest.fn(),
      truncateTable: jest.fn(),
      tableExists: jest.fn(),
      createTable: jest.fn(),
      destroy: jest.fn(),
    };

    expect(mockAdapter.connect).toBeDefined();
    expect(mockAdapter.destroy).toBeDefined();
    expect(mockAdapter.getForeignKeys).toBeDefined();
  });

  it('should allow constructing ReadFilter', () => {
    const filter: ReadFilter = {
      column: 'updated_at',
      operator: '>',
      value: '2026-03-28T12:00:00Z',
      orderBy: 'ASC',
    };

    expect(filter.column).toBe('updated_at');
    expect(filter.operator).toBe('>');
    expect(filter.orderBy).toBe('ASC');
  });

  it('should allow ReadFilter with numeric value', () => {
    const filter: ReadFilter = {
      column: 'id',
      operator: '>',
      value: 1000,
      orderBy: 'ASC',
    };

    expect(filter.value).toBe(1000);
  });

  it('should allow ReadFilter with Date value', () => {
    const filter: ReadFilter = {
      column: 'updated_at',
      operator: '>=',
      value: new Date('2026-03-28'),
      orderBy: 'ASC',
    };

    expect(filter.value).toBeInstanceOf(Date);
  });
});
