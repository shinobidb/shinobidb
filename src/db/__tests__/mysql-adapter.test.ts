import { DatabaseConnectionError, DatabaseQueryError } from '../../shared/errors.js';
import { MySQLAdapter } from '../mysql/mysql-adapter.js';

// Mock mysql2/promise
const mockRelease = jest.fn();
const mockGetConnection = jest.fn().mockResolvedValue({ release: mockRelease });
const mockQuery = jest.fn();
const mockEnd = jest.fn().mockResolvedValue(undefined);
const mockCreatePool = jest.fn().mockReturnValue({
  getConnection: mockGetConnection,
  query: mockQuery,
  end: mockEnd,
});

jest.mock('mysql2/promise', () => ({
  __esModule: true,
  default: {
    createPool: (...args: unknown[]) => mockCreatePool(...args),
  },
}));

// Mock logger
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

const testConfig = {
  type: 'mysql' as const,
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: 'test',
  database: 'testdb',
};

describe('MySQLAdapter', () => {
  let adapter: MySQLAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new MySQLAdapter(testConfig);
  });

  describe('connect', () => {
    it('should create a connection pool and verify connectivity', async () => {
      await adapter.connect();

      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'localhost',
          port: 3306,
          user: 'root',
          password: 'test',
          database: 'testdb',
        }),
      );
      expect(mockGetConnection).toHaveBeenCalled();
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should enable SSL when config.ssl is true', async () => {
      const sslAdapter = new MySQLAdapter({ ...testConfig, ssl: true });
      await sslAdapter.connect();

      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({ ssl: {} }));
    });

    it('should throw DatabaseConnectionError on failure', async () => {
      mockGetConnection.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(adapter.connect()).rejects.toThrow(DatabaseConnectionError);
    });
  });

  describe('getSchemas', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return schema names', async () => {
      mockQuery.mockResolvedValueOnce([[{ SCHEMA_NAME: 'mydb' }, { SCHEMA_NAME: 'sys' }]]);

      const schemas = await adapter.getSchemas();
      expect(schemas).toEqual(['mydb', 'sys']);
    });

    it('should throw DatabaseQueryError on failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('query error'));

      await expect(adapter.getSchemas()).rejects.toThrow(DatabaseQueryError);
    });
  });

  describe('getTables', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return table names for a schema', async () => {
      mockQuery.mockResolvedValueOnce([[{ TABLE_NAME: 'users' }, { TABLE_NAME: 'orders' }]]);

      const tables = await adapter.getTables('mydb');
      expect(tables).toEqual(['users', 'orders']);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('INFORMATION_SCHEMA.TABLES'), [
        'mydb',
        'BASE TABLE',
      ]);
    });
  });

  describe('getColumns', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return column info with FK detection', async () => {
      // First call: columns query
      mockQuery.mockResolvedValueOnce([
        [
          {
            COLUMN_NAME: 'id',
            COLUMN_TYPE: 'int',
            IS_NULLABLE: 'NO',
            COLUMN_KEY: 'PRI',
            COLUMN_DEFAULT: null,
            COLUMN_COMMENT: '',
          },
          {
            COLUMN_NAME: 'org_id',
            COLUMN_TYPE: 'int',
            IS_NULLABLE: 'NO',
            COLUMN_KEY: 'MUL',
            COLUMN_DEFAULT: null,
            COLUMN_COMMENT: 'FK to orgs',
          },
        ],
      ]);
      // Second call: FK column names query
      mockQuery.mockResolvedValueOnce([[{ COLUMN_NAME: 'org_id' }]]);

      const columns = await adapter.getColumns('mydb', 'users');
      expect(columns).toHaveLength(2);
      expect(columns[0]).toEqual({
        name: 'id',
        dataType: 'int',
        nullable: false,
        isPrimaryKey: true,
        isForeignKey: false,
        defaultValue: null,
        comment: null,
      });
      expect(columns[1]).toEqual({
        name: 'org_id',
        dataType: 'int',
        nullable: false,
        isPrimaryKey: false,
        isForeignKey: true,
        defaultValue: null,
        comment: 'FK to orgs',
      });
    });
  });

  describe('getRowCount', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return estimated row count', async () => {
      mockQuery.mockResolvedValueOnce([[{ TABLE_ROWS: 1500 }]]);

      const count = await adapter.getRowCount('mydb', 'users');
      expect(count).toBe(1500);
    });

    it('should return 0 when table not found', async () => {
      mockQuery.mockResolvedValueOnce([[]]);

      const count = await adapter.getRowCount('mydb', 'nonexistent');
      expect(count).toBe(0);
    });
  });

  describe('getForeignKeys', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return foreign key info', async () => {
      mockQuery.mockResolvedValueOnce([
        [
          {
            COLUMN_NAME: 'org_id',
            REFERENCED_TABLE_SCHEMA: 'mydb',
            REFERENCED_TABLE_NAME: 'orgs',
            REFERENCED_COLUMN_NAME: 'id',
          },
        ],
      ]);

      const fks = await adapter.getForeignKeys('mydb', 'users');
      expect(fks).toEqual([
        {
          column: 'org_id',
          referencedSchema: 'mydb',
          referencedTable: 'orgs',
          referencedColumn: 'id',
        },
      ]);
    });
  });

  describe('readRows', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should read rows in batches and stop when no more rows', async () => {
      const batch1 = [{ id: 1 }, { id: 2 }];
      const batch2 = [{ id: 3 }];
      mockQuery.mockResolvedValueOnce([batch1]);
      mockQuery.mockResolvedValueOnce([batch2]);

      const batches: Record<string, unknown>[][] = [];
      await adapter.readRows('mydb', 'users', 2, async (rows) => {
        batches.push(rows);
      });

      expect(batches).toHaveLength(2);
      expect(batches[0]).toEqual(batch1);
      expect(batches[1]).toEqual(batch2);
    });

    it('should stop when callback returns false', async () => {
      mockQuery.mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]]);

      const batches: Record<string, unknown>[][] = [];
      await adapter.readRows('mydb', 'users', 2, async (rows) => {
        batches.push(rows);
        return false;
      });

      expect(batches).toHaveLength(1);
      // Should not have made a second query
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('should stop when empty result set', async () => {
      mockQuery.mockResolvedValueOnce([[]]);

      const batches: Record<string, unknown>[][] = [];
      await adapter.readRows('mydb', 'users', 100, async (rows) => {
        batches.push(rows);
      });

      expect(batches).toHaveLength(0);
    });
  });

  describe('writeRows', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should insert rows with parameterized query', async () => {
      mockQuery.mockResolvedValueOnce([{ affectedRows: 2 }]);

      await adapter.writeRows('mydb', 'users', [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]);

      expect(mockQuery).toHaveBeenCalledWith(
        'INSERT INTO `mydb`.`users` (`id`, `name`) VALUES (?, ?), (?, ?)',
        [1, 'Alice', 2, 'Bob'],
      );
    });

    it('should do nothing for empty rows', async () => {
      await adapter.writeRows('mydb', 'users', []);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should throw DatabaseQueryError on failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Duplicate entry'));

      await expect(adapter.writeRows('mydb', 'users', [{ id: 1 }])).rejects.toThrow(
        DatabaseQueryError,
      );
    });
  });

  describe('truncateTable', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should truncate the table', async () => {
      mockQuery.mockResolvedValueOnce([{}]);

      await adapter.truncateTable('mydb', 'users');
      expect(mockQuery).toHaveBeenCalledWith('TRUNCATE TABLE `mydb`.`users`');
    });
  });

  describe('destroy', () => {
    it('should end the pool', async () => {
      await adapter.connect();
      await adapter.destroy();

      expect(mockEnd).toHaveBeenCalled();
    });

    it('should be safe to call when not connected', async () => {
      await adapter.destroy();
      expect(mockEnd).not.toHaveBeenCalled();
    });
  });

  describe('updateRows', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should generate CASE-based UPDATE for single PK', async () => {
      mockQuery.mockResolvedValueOnce([[], []]);

      await adapter.updateRows(
        'testdb',
        'users',
        [
          { id: 1, email: 'masked1@example.com' },
          { id: 2, email: 'masked2@example.com' },
        ],
        'id',
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE `testdb`.`users` SET'),
        expect.any(Array),
      );
      // Should use CASE expression for efficiency
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('CASE');
      expect(sql).toContain('WHERE `id` IN');
    });

    it('should use transaction for composite PK', async () => {
      const mockConnection = {
        beginTransaction: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([[], []]),
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
        release: jest.fn(),
      };
      mockGetConnection.mockResolvedValueOnce(mockConnection);

      await adapter.updateRows(
        'testdb',
        'order_items',
        [{ order_id: 1, item_id: 10, note: 'masked' }],
        ['order_id', 'item_id'],
      );

      expect(mockConnection.beginTransaction).toHaveBeenCalled();
      expect(mockConnection.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE'),
        expect.any(Array),
      );
      expect(mockConnection.commit).toHaveBeenCalled();
      expect(mockConnection.release).toHaveBeenCalled();
    });

    it('should rollback on error for composite PK', async () => {
      const mockConnection = {
        beginTransaction: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockRejectedValue(new Error('DB error')),
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
        release: jest.fn(),
      };
      mockGetConnection.mockResolvedValueOnce(mockConnection);

      await expect(
        adapter.updateRows(
          'testdb',
          'order_items',
          [{ order_id: 1, item_id: 10, note: 'masked' }],
          ['order_id', 'item_id'],
        ),
      ).rejects.toThrow(DatabaseQueryError);

      expect(mockConnection.rollback).toHaveBeenCalled();
      expect(mockConnection.release).toHaveBeenCalled();
    });

    it('should skip if rows is empty', async () => {
      await adapter.updateRows('testdb', 'users', [], 'id');
      // connect query only, no UPDATE query
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should skip if no non-PK columns to update', async () => {
      mockQuery.mockResolvedValueOnce([[], []]);
      await adapter.updateRows('testdb', 'users', [{ id: 1 }], 'id');
      // No UPDATE should be issued
      expect(mockQuery).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE'),
        expect.any(Array),
      );
    });
  });

  describe('when not connected', () => {
    it('should throw DatabaseConnectionError for operations', async () => {
      await expect(adapter.getSchemas()).rejects.toThrow(DatabaseConnectionError);
    });
  });
});
