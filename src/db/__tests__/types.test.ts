import type { ColumnInfo, DatabaseAdapter, ForeignKeyInfo, TableInfo } from '../types.js';

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
      truncateTable: jest.fn(),
      tableExists: jest.fn(),
      createTable: jest.fn(),
      destroy: jest.fn(),
    };

    expect(mockAdapter.connect).toBeDefined();
    expect(mockAdapter.destroy).toBeDefined();
    expect(mockAdapter.getForeignKeys).toBeDefined();
  });
});
