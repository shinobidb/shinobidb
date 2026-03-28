import { MongoClient, type Document } from 'mongodb';

import { DatabaseConnectionError, DatabaseQueryError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import type { DatabaseConnectionConfig } from '../../shared/types.js';
import type { ColumnInfo, DatabaseAdapter, ForeignKeyInfo } from '../types.js';

const SAMPLE_SIZE = 100;

const SYSTEM_DATABASES = ['admin', 'local', 'config'];

export class MongoDBAdapter implements DatabaseAdapter {
  private client: MongoClient | null = null;
  private readonly config: DatabaseConnectionConfig;

  constructor(config: DatabaseConnectionConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      const protocol = this.config.ssl ? 'mongodb+srv' : 'mongodb';
      const url = `${protocol}://${encodeURIComponent(this.config.user)}:${encodeURIComponent(this.config.password)}@${this.config.host}:${this.config.port}`;

      this.client = new MongoClient(url, {
        maxPoolSize: 5,
      });

      await this.client.connect();
      // Verify connectivity
      await this.client.db('admin').command({ ping: 1 });
      logger.debug('MongoDB connection established');
    } catch (error) {
      throw new DatabaseConnectionError(
        `Failed to connect to MongoDB at ${this.config.host}:${this.config.port}`,
        error,
      );
    }
  }

  async getSchemas(): Promise<string[]> {
    const client = this.getClient();
    try {
      // If a specific database is configured, return only that
      if (this.config.database) {
        return [this.config.database];
      }

      const admin = client.db('admin');
      const result = await admin.command({ listDatabases: 1, nameOnly: true });
      const databases = (result.databases as Array<{ name: string }>)
        .map((db) => db.name)
        .filter((name) => !SYSTEM_DATABASES.includes(name))
        .sort();
      return databases;
    } catch (error) {
      throw new DatabaseQueryError('Failed to retrieve databases', error);
    }
  }

  async getTables(schema: string): Promise<string[]> {
    const client = this.getClient();
    try {
      const db = client.db(schema);
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();
      return collections
        .map((c) => c.name)
        .filter((name) => !name.startsWith('system.'))
        .sort();
    } catch (error) {
      throw new DatabaseQueryError(`Failed to retrieve collections for database: ${schema}`, error);
    }
  }

  async getColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const client = this.getClient();
    try {
      const db = client.db(schema);
      const collection = db.collection(table);

      // Sample documents to infer schema
      const docs = await collection
        .aggregate<Document>([{ $sample: { size: SAMPLE_SIZE } }])
        .toArray();

      if (docs.length === 0) {
        return [];
      }

      // Build field info from sampled documents
      const fieldMap = new Map<string, { types: Set<string>; nullCount: number; hasId: boolean }>();

      for (const doc of docs) {
        for (const [key, value] of Object.entries(doc)) {
          if (!fieldMap.has(key)) {
            fieldMap.set(key, { types: new Set(), nullCount: 0, hasId: key === '_id' });
          }
          const info = fieldMap.get(key)!;
          if (value === null || value === undefined) {
            info.nullCount++;
          } else {
            info.types.add(inferBsonType(value));
          }
        }

        // Track fields missing from this document as nullable
        for (const [key, info] of fieldMap) {
          if (!(key in doc)) {
            info.nullCount++;
          }
        }
      }

      const columns: ColumnInfo[] = [];
      for (const [name, info] of fieldMap) {
        const typeStr = info.types.size > 0 ? [...info.types].sort().join('|') : 'null';
        columns.push({
          name,
          dataType: typeStr,
          nullable: info.nullCount > 0,
          isPrimaryKey: name === '_id',
          isForeignKey: false,
          defaultValue: null,
          comment: null,
        });
      }

      // Sort: _id first, then alphabetical
      columns.sort((a, b) => {
        if (a.name === '_id') return -1;
        if (b.name === '_id') return 1;
        return a.name.localeCompare(b.name);
      });

      return columns;
    } catch (error) {
      throw new DatabaseQueryError(`Failed to retrieve columns for ${schema}.${table}`, error);
    }
  }

  async getRowCount(schema: string, table: string): Promise<number> {
    const client = this.getClient();
    try {
      const db = client.db(schema);
      const collection = db.collection(table);
      return await collection.estimatedDocumentCount();
    } catch (error) {
      throw new DatabaseQueryError(`Failed to get row count for ${schema}.${table}`, error);
    }
  }

  async getForeignKeys(_schema: string, _table: string): Promise<ForeignKeyInfo[]> {
    // MongoDB does not have native foreign key constraints
    return [];
  }

  async readRows(
    schema: string,
    table: string,
    batchSize: number,
    onBatch: (rows: Record<string, unknown>[]) => Promise<boolean | void>,
  ): Promise<void> {
    const client = this.getClient();
    const db = client.db(schema);
    const collection = db.collection(table);

    let offset = 0;

    try {
      while (true) {
        const docs = await collection.find({}).skip(offset).limit(batchSize).toArray();

        if (docs.length === 0) break;

        // Convert ObjectId to string for _id field
        const rows = docs.map((doc) => {
          const row: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(doc)) {
            row[key] = key === '_id' ? String(value) : value;
          }
          return row;
        });

        const shouldContinue = await onBatch(rows);
        if (shouldContinue === false) break;

        if (docs.length < batchSize) break;
        offset += batchSize;
      }
    } catch (error) {
      if (error instanceof DatabaseQueryError) throw error;
      throw new DatabaseQueryError(`Failed to read rows from ${schema}.${table}`, error);
    }
  }

  async writeRows(schema: string, table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;

    const client = this.getClient();
    const db = client.db(schema);
    const collection = db.collection(table);

    try {
      await collection.insertMany(rows as Document[]);
      logger.debug(`Wrote ${rows.length} rows to ${schema}.${table}`);
    } catch (error) {
      throw new DatabaseQueryError(`Failed to write rows to ${schema}.${table}`, error);
    }
  }

  async truncateTable(schema: string, table: string): Promise<void> {
    const client = this.getClient();
    const db = client.db(schema);
    const collection = db.collection(table);

    try {
      await collection.deleteMany({});
      logger.debug(`Truncated collection ${schema}.${table}`);
    } catch (error) {
      throw new DatabaseQueryError(`Failed to truncate collection ${schema}.${table}`, error);
    }
  }

  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      logger.debug('MongoDB connection closed');
    }
  }

  private getClient(): MongoClient {
    if (!this.client) {
      throw new DatabaseConnectionError('Not connected. Call connect() first.');
    }
    return this.client;
  }
}

function inferBsonType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (typeof value === 'boolean') return 'bool';
  if (value instanceof Date) return 'date';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') {
    // Check for ObjectId (has toHexString method)
    if (
      'toHexString' in value &&
      typeof (value as { toHexString: unknown }).toHexString === 'function'
    ) {
      return 'objectId';
    }
    return 'object';
  }
  return 'unknown';
}
