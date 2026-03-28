import { DatabaseConnectionError, DatabaseQueryError } from '../../shared/errors.js';
import { MongoDBAdapter } from '../mongodb/mongodb-adapter.js';

// Mock mongodb
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockCommand = jest.fn().mockResolvedValue({ ok: 1 });
const mockToArray = jest.fn();
const mockLimit = jest.fn().mockReturnValue({ toArray: mockToArray });
const mockSkip = jest.fn().mockReturnValue({ limit: mockLimit });
const mockFind = jest.fn().mockReturnValue({ skip: mockSkip });
const mockInsertMany = jest.fn().mockResolvedValue({ insertedCount: 0 });
const mockDeleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 });
const mockEstimatedDocumentCount = jest.fn().mockResolvedValue(0);
const mockAggregateToArray = jest.fn().mockResolvedValue([]);
const mockAggregate = jest.fn().mockReturnValue({ toArray: mockAggregateToArray });
const mockCollection = jest.fn().mockReturnValue({
  find: mockFind,
  insertMany: mockInsertMany,
  deleteMany: mockDeleteMany,
  estimatedDocumentCount: mockEstimatedDocumentCount,
  aggregate: mockAggregate,
});
const mockListCollectionsToArray = jest.fn().mockResolvedValue([]);
const mockListCollections = jest.fn().mockReturnValue({ toArray: mockListCollectionsToArray });
const mockDb = jest.fn().mockReturnValue({
  command: mockCommand,
  collection: mockCollection,
  listCollections: mockListCollections,
});
const mockConnect = jest.fn().mockResolvedValue(undefined);

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    db: mockDb,
  })),
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
  type: 'mongodb' as const,
  host: 'localhost',
  port: 27017,
  user: 'admin',
  password: 'test',
  database: 'testdb',
};

describe('MongoDBAdapter', () => {
  let adapter: MongoDBAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new MongoDBAdapter(testConfig);
  });

  describe('connect', () => {
    it('should create a MongoClient and verify connectivity', async () => {
      const { MongoClient } = await import('mongodb');
      await adapter.connect();

      expect(MongoClient).toHaveBeenCalledWith(
        expect.stringContaining('mongodb://admin:test@localhost:27017'),
        expect.objectContaining({ maxPoolSize: 5 }),
      );
      expect(mockConnect).toHaveBeenCalled();
      expect(mockDb).toHaveBeenCalledWith('admin');
      expect(mockCommand).toHaveBeenCalledWith({ ping: 1 });
    });

    it('should use mongodb+srv protocol when ssl is true', async () => {
      const { MongoClient } = await import('mongodb');
      const sslAdapter = new MongoDBAdapter({ ...testConfig, ssl: true });
      await sslAdapter.connect();

      expect(MongoClient).toHaveBeenCalledWith(
        expect.stringContaining('mongodb+srv://'),
        expect.anything(),
      );
    });

    it('should throw DatabaseConnectionError on failure', async () => {
      mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(adapter.connect()).rejects.toThrow(DatabaseConnectionError);
    });

    it('should URL-encode special characters in credentials', async () => {
      const { MongoClient } = await import('mongodb');
      const specialAdapter = new MongoDBAdapter({
        ...testConfig,
        user: 'user@domain',
        password: 'p@ss:word',
      });
      await specialAdapter.connect();

      expect(MongoClient).toHaveBeenCalledWith(
        expect.stringContaining('user%40domain:p%40ss%3Aword'),
        expect.anything(),
      );
    });
  });

  describe('getSchemas', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return only the configured database when database is set', async () => {
      const schemas = await adapter.getSchemas();
      expect(schemas).toEqual(['testdb']);
    });

    it('should list all databases excluding system ones when no database configured', async () => {
      const noDatabaseAdapter = new MongoDBAdapter({
        ...testConfig,
        database: undefined,
      });
      await noDatabaseAdapter.connect();

      mockCommand.mockResolvedValueOnce({
        databases: [
          { name: 'admin' },
          { name: 'local' },
          { name: 'config' },
          { name: 'myapp' },
          { name: 'analytics' },
        ],
      });

      const schemas = await noDatabaseAdapter.getSchemas();
      expect(schemas).toEqual(['analytics', 'myapp']);
    });

    it('should throw DatabaseQueryError on failure', async () => {
      const noDatabaseAdapter = new MongoDBAdapter({
        ...testConfig,
        database: undefined,
      });
      await noDatabaseAdapter.connect();

      mockCommand.mockRejectedValueOnce(new Error('not authorized'));

      await expect(noDatabaseAdapter.getSchemas()).rejects.toThrow(DatabaseQueryError);
    });
  });

  describe('getTables', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return collection names excluding system collections', async () => {
      mockListCollectionsToArray.mockResolvedValueOnce([
        { name: 'users' },
        { name: 'orders' },
        { name: 'system.views' },
      ]);

      const tables = await adapter.getTables('testdb');
      expect(tables).toEqual(['orders', 'users']);
      expect(mockDb).toHaveBeenCalledWith('testdb');
    });

    it('should throw DatabaseQueryError on failure', async () => {
      mockListCollectionsToArray.mockRejectedValueOnce(new Error('db error'));

      await expect(adapter.getTables('testdb')).rejects.toThrow(DatabaseQueryError);
    });
  });

  describe('getColumns', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should infer schema from sampled documents', async () => {
      mockAggregateToArray.mockResolvedValueOnce([
        {
          _id: { toHexString: () => '507f1f77bcf86cd799439011' },
          name: 'Alice',
          age: 30,
          email: 'alice@example.com',
        },
        {
          _id: { toHexString: () => '507f1f77bcf86cd799439012' },
          name: 'Bob',
          age: 25,
          email: null,
        },
      ]);

      const columns = await adapter.getColumns('testdb', 'users');

      expect(columns[0]).toEqual({
        name: '_id',
        dataType: 'objectId',
        nullable: false,
        isPrimaryKey: true,
        isForeignKey: false,
        defaultValue: null,
        comment: null,
      });

      const nameCol = columns.find((c) => c.name === 'name');
      expect(nameCol).toEqual({
        name: 'name',
        dataType: 'string',
        nullable: false,
        isPrimaryKey: false,
        isForeignKey: false,
        defaultValue: null,
        comment: null,
      });

      const ageCol = columns.find((c) => c.name === 'age');
      expect(ageCol?.dataType).toBe('int');

      const emailCol = columns.find((c) => c.name === 'email');
      expect(emailCol?.nullable).toBe(true);
    });

    it('should return empty array for empty collection', async () => {
      mockAggregateToArray.mockResolvedValueOnce([]);

      const columns = await adapter.getColumns('testdb', 'empty');
      expect(columns).toEqual([]);
    });

    it('should handle mixed types', async () => {
      mockAggregateToArray.mockResolvedValueOnce([
        { _id: { toHexString: () => '1' }, value: 42 },
        { _id: { toHexString: () => '2' }, value: 'text' },
      ]);

      const columns = await adapter.getColumns('testdb', 'mixed');
      const valueCol = columns.find((c) => c.name === 'value');
      expect(valueCol?.dataType).toBe('int|string');
    });

    it('should detect fields missing in some documents as nullable', async () => {
      mockAggregateToArray.mockResolvedValueOnce([
        { _id: { toHexString: () => '1' }, name: 'Alice', phone: '123' },
        { _id: { toHexString: () => '2' }, name: 'Bob' },
      ]);

      const columns = await adapter.getColumns('testdb', 'users');
      const phoneCol = columns.find((c) => c.name === 'phone');
      expect(phoneCol?.nullable).toBe(true);
    });

    it('should throw DatabaseQueryError on failure', async () => {
      mockAggregateToArray.mockRejectedValueOnce(new Error('aggregate error'));

      await expect(adapter.getColumns('testdb', 'users')).rejects.toThrow(DatabaseQueryError);
    });
  });

  describe('getRowCount', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should return estimated document count', async () => {
      mockEstimatedDocumentCount.mockResolvedValueOnce(1500);

      const count = await adapter.getRowCount('testdb', 'users');
      expect(count).toBe(1500);
    });

    it('should throw DatabaseQueryError on failure', async () => {
      mockEstimatedDocumentCount.mockRejectedValueOnce(new Error('count error'));

      await expect(adapter.getRowCount('testdb', 'users')).rejects.toThrow(DatabaseQueryError);
    });
  });

  describe('getForeignKeys', () => {
    it('should always return empty array', async () => {
      await adapter.connect();
      const fks = await adapter.getForeignKeys('testdb', 'users');
      expect(fks).toEqual([]);
    });
  });

  describe('readRows', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should read documents in batches and stop when no more rows', async () => {
      const batch1 = [
        { _id: { toString: () => '1' }, name: 'Alice' },
        { _id: { toString: () => '2' }, name: 'Bob' },
      ];
      const batch2 = [{ _id: { toString: () => '3' }, name: 'Charlie' }];
      mockToArray.mockResolvedValueOnce(batch1);
      mockToArray.mockResolvedValueOnce(batch2);

      const batches: Record<string, unknown>[][] = [];
      await adapter.readRows('testdb', 'users', 2, async (rows) => {
        batches.push(rows);
      });

      expect(batches).toHaveLength(2);
      // _id should be converted to string
      expect(batches[0]![0]!['_id']).toBe('1');
    });

    it('should stop when callback returns false', async () => {
      mockToArray.mockResolvedValueOnce([
        { _id: { toString: () => '1' }, name: 'Alice' },
        { _id: { toString: () => '2' }, name: 'Bob' },
      ]);

      const batches: Record<string, unknown>[][] = [];
      await adapter.readRows('testdb', 'users', 2, async (rows) => {
        batches.push(rows);
        return false;
      });

      expect(batches).toHaveLength(1);
    });

    it('should stop when empty result set', async () => {
      mockToArray.mockResolvedValueOnce([]);

      const batches: Record<string, unknown>[][] = [];
      await adapter.readRows('testdb', 'users', 100, async (rows) => {
        batches.push(rows);
      });

      expect(batches).toHaveLength(0);
    });
  });

  describe('writeRows', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should insert documents with insertMany', async () => {
      mockInsertMany.mockResolvedValueOnce({ insertedCount: 2 });

      await adapter.writeRows('testdb', 'users', [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ]);

      expect(mockInsertMany).toHaveBeenCalledWith([
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ]);
    });

    it('should do nothing for empty rows', async () => {
      await adapter.writeRows('testdb', 'users', []);
      expect(mockInsertMany).not.toHaveBeenCalled();
    });

    it('should throw DatabaseQueryError on failure', async () => {
      mockInsertMany.mockRejectedValueOnce(new Error('Duplicate key'));

      await expect(adapter.writeRows('testdb', 'users', [{ id: 1 }])).rejects.toThrow(
        DatabaseQueryError,
      );
    });
  });

  describe('truncateTable', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should delete all documents in the collection', async () => {
      mockDeleteMany.mockResolvedValueOnce({ deletedCount: 10 });

      await adapter.truncateTable('testdb', 'users');
      expect(mockDeleteMany).toHaveBeenCalledWith({});
    });

    it('should throw DatabaseQueryError on failure', async () => {
      mockDeleteMany.mockRejectedValueOnce(new Error('delete error'));

      await expect(adapter.truncateTable('testdb', 'users')).rejects.toThrow(DatabaseQueryError);
    });
  });

  describe('destroy', () => {
    it('should close the client', async () => {
      await adapter.connect();
      await adapter.destroy();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should be safe to call when not connected', async () => {
      await adapter.destroy();
      expect(mockClose).not.toHaveBeenCalled();
    });
  });

  describe('when not connected', () => {
    it('should throw DatabaseConnectionError for operations', async () => {
      await expect(adapter.getSchemas()).rejects.toThrow(DatabaseConnectionError);
    });
  });
});
