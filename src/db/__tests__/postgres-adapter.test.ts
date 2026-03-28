import { DatabaseConnectionError, DatabaseQueryError } from '../../shared/errors.js';
import { PostgresAdapter } from '../postgres/postgres-adapter.js';

// Mock pg
const mockRelease = jest.fn();
const mockPoolConnect = jest.fn().mockResolvedValue({ release: mockRelease });
const mockQuery = jest.fn();
const mockEnd = jest.fn().mockResolvedValue(undefined);

jest.mock('pg', () => ({
  __esModule: true,
  default: {
    Pool: jest.fn().mockImplementation(() => ({
      connect: mockPoolConnect,
      query: mockQuery,
      end: mockEnd,
    })),
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
  type: 'postgres' as const,
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'test',
  database: 'testdb',
};

describe('PostgresAdapter', () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new PostgresAdapter(testConfig);
  });

  describe('connect', () => {
    it('should create a connection pool and verify connectivity', async () => {
      const pg = await import('pg');
      await adapter.connect();

      expect(pg.default.Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'localhost',
          port: 5432,
          user: 'postgres',
          password: 'test',
          database: 'testdb',
        }),
      );
      expect(mockPoolConnect).toHaveBeenCalled();
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should enable SSL when config.ssl is true', async () => {
      const pg = await import('pg');
      const sslAdapter = new PostgresAdapter({ ...testConfig, ssl: true });
      await sslAdapter.connect();

      expect(pg.default.Pool).toHaveBeenCalledWith(
        expect.objectContaining({ ssl: { rejectUnauthorized: false } }),
      );
    });

    it('should throw DatabaseConnectionError on failure', async () => {
      mockPoolConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(adapter.connect()).rejects.toThrow(DatabaseConnectionError);
    });
  });

  describe('getSchemas', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return schema names excluding system schemas', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ schema_name: 'public' }, { schema_name: 'myschema' }],
      });

      const schemas = await adapter.getSchemas();
      expect(schemas).toEqual(['public', 'myschema']);
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
      mockQuery.mockResolvedValueOnce({
        rows: [{ table_name: 'users' }, { table_name: 'orders' }],
      });

      const tables = await adapter.getTables('public');
      expect(tables).toEqual(['users', 'orders']);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('information_schema.tables'), [
        'public',
        'BASE TABLE',
      ]);
    });
  });

  describe('getColumns', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return column info with PK and FK detection', async () => {
      // First call: columns query
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            column_name: 'id',
            data_type: 'integer',
            is_nullable: 'NO',
            column_default: "nextval('users_id_seq'::regclass)",
            is_primary_key: true,
          },
          {
            column_name: 'org_id',
            data_type: 'integer',
            is_nullable: 'NO',
            column_default: null,
            is_primary_key: false,
          },
        ],
      });
      // Second call: FK column names query
      mockQuery.mockResolvedValueOnce({
        rows: [{ column_name: 'org_id' }],
      });

      const columns = await adapter.getColumns('public', 'users');
      expect(columns).toHaveLength(2);
      expect(columns[0]).toEqual({
        name: 'id',
        dataType: 'integer',
        nullable: false,
        isPrimaryKey: true,
        isForeignKey: false,
        defaultValue: "nextval('users_id_seq'::regclass)",
        comment: null,
      });
      expect(columns[1]).toEqual({
        name: 'org_id',
        dataType: 'integer',
        nullable: false,
        isPrimaryKey: false,
        isForeignKey: true,
        defaultValue: null,
        comment: null,
      });
    });
  });

  describe('getRowCount', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return estimated row count', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ estimate: 1500 }],
      });

      const count = await adapter.getRowCount('public', 'users');
      expect(count).toBe(1500);
    });

    it('should return 0 when table not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const count = await adapter.getRowCount('public', 'nonexistent');
      expect(count).toBe(0);
    });

    it('should return 0 for negative estimates (never analyzed)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ estimate: -1 }],
      });

      const count = await adapter.getRowCount('public', 'users');
      expect(count).toBe(0);
    });
  });

  describe('getForeignKeys', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return foreign key info', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            column_name: 'org_id',
            referenced_table_schema: 'public',
            referenced_table_name: 'orgs',
            referenced_column_name: 'id',
          },
        ],
      });

      const fks = await adapter.getForeignKeys('public', 'users');
      expect(fks).toEqual([
        {
          column: 'org_id',
          referencedSchema: 'public',
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
      mockQuery.mockResolvedValueOnce({ rows: batch1 });
      mockQuery.mockResolvedValueOnce({ rows: batch2 });

      const batches: Record<string, unknown>[][] = [];
      await adapter.readRows('public', 'users', 2, async (rows) => {
        batches.push(rows);
      });

      expect(batches).toHaveLength(2);
      expect(batches[0]).toEqual(batch1);
      expect(batches[1]).toEqual(batch2);
    });

    it('should stop when callback returns false', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });

      const batches: Record<string, unknown>[][] = [];
      await adapter.readRows('public', 'users', 2, async (rows) => {
        batches.push(rows);
        return false;
      });

      expect(batches).toHaveLength(1);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('should stop when empty result set', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const batches: Record<string, unknown>[][] = [];
      await adapter.readRows('public', 'users', 100, async (rows) => {
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
      mockQuery.mockResolvedValueOnce({ rowCount: 2 });

      await adapter.writeRows('public', 'users', [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]);

      expect(mockQuery).toHaveBeenCalledWith(
        'INSERT INTO "public"."users" ("id", "name") VALUES ($1, $2), ($3, $4)',
        [1, 'Alice', 2, 'Bob'],
      );
    });

    it('should do nothing for empty rows', async () => {
      await adapter.writeRows('public', 'users', []);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should throw DatabaseQueryError on failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Duplicate key'));

      await expect(adapter.writeRows('public', 'users', [{ id: 1 }])).rejects.toThrow(
        DatabaseQueryError,
      );
    });
  });

  describe('truncateTable', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should truncate the table', async () => {
      mockQuery.mockResolvedValueOnce({});

      await adapter.truncateTable('public', 'users');
      expect(mockQuery).toHaveBeenCalledWith('TRUNCATE TABLE "public"."users"');
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

  describe('when not connected', () => {
    it('should throw DatabaseConnectionError for operations', async () => {
      await expect(adapter.getSchemas()).rejects.toThrow(DatabaseConnectionError);
    });
  });
});
