import {
  assertValidFilterOperator,
  validateDefaultValue,
  type ColumnInfo,
  type DatabaseAdapter,
  type ForeignKeyInfo,
  type ReadFilter,
  type TableInfo,
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
      updateRows: jest.fn(),
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

describe('validateDefaultValue', () => {
  it('should accept safe default values', () => {
    expect(validateDefaultValue('NULL')).toBe(true);
    expect(validateDefaultValue('0')).toBe(true);
    expect(validateDefaultValue('3.14')).toBe(true);
    expect(validateDefaultValue("'hello'")).toBe(true);
    expect(validateDefaultValue("''")).toBe(true);
    expect(validateDefaultValue('CURRENT_TIMESTAMP')).toBe(true);
    expect(validateDefaultValue('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')).toBe(true);
    expect(validateDefaultValue('TRUE')).toBe(true);
    expect(validateDefaultValue('FALSE')).toBe(true);
    expect(validateDefaultValue('gen_random_uuid()')).toBe(true);
    expect(validateDefaultValue("nextval('users_id_seq'::regclass)")).toBe(true);
    expect(validateDefaultValue("'value'::text")).toBe(true);
  });

  it('should reject values with semicolons (statement separator)', () => {
    expect(validateDefaultValue('0; DROP TABLE users')).toBe(false);
    expect(validateDefaultValue("''; DELETE FROM users;")).toBe(false);
  });

  it('should reject values with SQL comments', () => {
    expect(validateDefaultValue('0 -- malicious comment')).toBe(false);
    expect(validateDefaultValue('0 /* block comment */')).toBe(false);
    expect(validateDefaultValue('/* start */ 0')).toBe(false);
  });
});

describe('assertValidFilterOperator', () => {
  it('should accept valid operators', () => {
    expect(() => assertValidFilterOperator('>')).not.toThrow();
    expect(() => assertValidFilterOperator('>=')).not.toThrow();
  });

  it('should reject invalid operators', () => {
    expect(() => assertValidFilterOperator('>= 1 OR 1=1')).toThrow('Invalid filter operator');
    expect(() => assertValidFilterOperator('< 1; DROP TABLE')).toThrow('Invalid filter operator');
    expect(() => assertValidFilterOperator('')).toThrow('Invalid filter operator');
    expect(() => assertValidFilterOperator('<')).toThrow('Invalid filter operator');
  });
});
