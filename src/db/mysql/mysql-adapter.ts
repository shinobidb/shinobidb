import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';

import { DatabaseConnectionError, DatabaseQueryError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import type { DatabaseConnectionConfig } from '../../shared/types.js';
import type { ColumnInfo, DatabaseAdapter, ForeignKeyInfo, ReadFilter } from '../types.js';

export class MySQLAdapter implements DatabaseAdapter {
  private pool: Pool | null = null;
  private readonly config: DatabaseConnectionConfig;

  constructor(config: DatabaseConnectionConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      const poolOptions: PoolOptions = {
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        ssl: this.config.ssl ? {} : undefined,
        waitForConnections: true,
        connectionLimit: 5,
      };

      this.pool = mysql.createPool(poolOptions);

      // Verify the connection works
      const connection = await this.pool.getConnection();
      connection.release();
      logger.debug('MySQL connection pool created');
    } catch (error) {
      throw new DatabaseConnectionError(
        `Failed to connect to MySQL at ${this.config.host}:${this.config.port}`,
        error,
      );
    }
  }

  async getSchemas(): Promise<string[]> {
    const pool = this.getPool();
    try {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA ORDER BY SCHEMA_NAME',
      );
      return rows.map((row) => row['SCHEMA_NAME'] as string);
    } catch (error) {
      throw new DatabaseQueryError('Failed to retrieve schemas', error);
    }
  }

  async getTables(schema: string): Promise<string[]> {
    const pool = this.getPool();
    try {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ? ORDER BY TABLE_NAME',
        [schema, 'BASE TABLE'],
      );
      return rows.map((row) => row['TABLE_NAME'] as string);
    } catch (error) {
      throw new DatabaseQueryError(`Failed to retrieve tables for schema: ${schema}`, error);
    }
  }

  async getColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const pool = this.getPool();
    try {
      const [columns] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT
          c.COLUMN_NAME,
          c.DATA_TYPE,
          c.IS_NULLABLE,
          c.COLUMN_KEY,
          c.COLUMN_DEFAULT,
          c.COLUMN_COMMENT
        FROM INFORMATION_SCHEMA.COLUMNS c
        WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
        ORDER BY c.ORDINAL_POSITION`,
        [schema, table],
      );

      const foreignKeyColumns = await this.getForeignKeyColumnNames(pool, schema, table);

      return columns.map((col) => ({
        name: col['COLUMN_NAME'] as string,
        dataType: col['DATA_TYPE'] as string,
        nullable: col['IS_NULLABLE'] === 'YES',
        isPrimaryKey: col['COLUMN_KEY'] === 'PRI',
        isForeignKey: foreignKeyColumns.has(col['COLUMN_NAME'] as string),
        defaultValue: (col['COLUMN_DEFAULT'] as string | null) ?? null,
        comment: (col['COLUMN_COMMENT'] as string) || null,
      }));
    } catch (error) {
      throw new DatabaseQueryError(`Failed to retrieve columns for ${schema}.${table}`, error);
    }
  }

  async getRowCount(schema: string, table: string): Promise<number> {
    const pool = this.getPool();
    try {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        'SELECT TABLE_ROWS FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [schema, table],
      );
      const row = rows[0];
      return row ? ((row['TABLE_ROWS'] as number) ?? 0) : 0;
    } catch (error) {
      throw new DatabaseQueryError(`Failed to get row count for ${schema}.${table}`, error);
    }
  }

  async getForeignKeys(schema: string, table: string): Promise<ForeignKeyInfo[]> {
    const pool = this.getPool();
    try {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT
          COLUMN_NAME,
          REFERENCED_TABLE_SCHEMA,
          REFERENCED_TABLE_NAME,
          REFERENCED_COLUMN_NAME
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [schema, table],
      );

      return rows.map((row) => ({
        column: row['COLUMN_NAME'] as string,
        referencedSchema: row['REFERENCED_TABLE_SCHEMA'] as string,
        referencedTable: row['REFERENCED_TABLE_NAME'] as string,
        referencedColumn: row['REFERENCED_COLUMN_NAME'] as string,
      }));
    } catch (error) {
      throw new DatabaseQueryError(`Failed to retrieve foreign keys for ${schema}.${table}`, error);
    }
  }

  async readRows(
    schema: string,
    table: string,
    batchSize: number,
    onBatch: (rows: Record<string, unknown>[]) => Promise<boolean | void>,
    filter?: ReadFilter,
  ): Promise<void> {
    const pool = this.getPool();
    const identifier = `\`${schema}\`.\`${table}\``;
    let offset = 0;

    try {
      while (true) {
        let sql: string;
        let params: unknown[];

        if (filter) {
          sql = `SELECT * FROM ${identifier} WHERE \`${filter.column}\` ${filter.operator} ? ORDER BY \`${filter.column}\` ASC LIMIT ? OFFSET ?`;
          params = [filter.value, batchSize, offset];
        } else {
          sql = `SELECT * FROM ${identifier} LIMIT ? OFFSET ?`;
          params = [batchSize, offset];
        }

        const [rows] = await pool.query<mysql.RowDataPacket[]>(sql, params);

        if (rows.length === 0) break;

        const shouldContinue = await onBatch(rows as Record<string, unknown>[]);
        if (shouldContinue === false) break;

        if (rows.length < batchSize) break;
        offset += batchSize;
      }
    } catch (error) {
      if (error instanceof DatabaseQueryError) throw error;
      throw new DatabaseQueryError(`Failed to read rows from ${schema}.${table}`, error);
    }
  }

  async writeRows(schema: string, table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;

    const pool = this.getPool();
    const identifier = `\`${schema}\`.\`${table}\``;

    try {
      const firstRow = rows[0]!;
      const columnNames = Object.keys(firstRow);
      const escapedColumns = columnNames.map((c) => `\`${c}\``).join(', ');
      const placeholders = columnNames.map(() => '?').join(', ');
      const rowPlaceholders = rows.map(() => `(${placeholders})`).join(', ');
      const values = rows.flatMap((row) => columnNames.map((col) => row[col] ?? null));

      await pool.query(
        `INSERT INTO ${identifier} (${escapedColumns}) VALUES ${rowPlaceholders}`,
        values,
      );

      logger.debug(`Wrote ${rows.length} rows to ${schema}.${table}`);
    } catch (error) {
      throw new DatabaseQueryError(`Failed to write rows to ${schema}.${table}`, error);
    }
  }

  async upsertRows(
    schema: string,
    table: string,
    rows: Record<string, unknown>[],
    primaryKey: string | string[],
  ): Promise<void> {
    if (rows.length === 0) return;

    const pool = this.getPool();
    const identifier = `\`${schema}\`.\`${table}\``;
    const pkColumns = Array.isArray(primaryKey) ? primaryKey : [primaryKey];

    try {
      const firstRow = rows[0]!;
      const columnNames = Object.keys(firstRow);
      const escapedColumns = columnNames.map((c) => `\`${c}\``).join(', ');
      const placeholders = columnNames.map(() => '?').join(', ');
      const rowPlaceholders = rows.map(() => `(${placeholders})`).join(', ');
      const values = rows.flatMap((row) => columnNames.map((col) => row[col] ?? null));

      const updateColumns = columnNames
        .filter((c) => !pkColumns.includes(c))
        .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
        .join(', ');

      const sql = updateColumns
        ? `INSERT INTO ${identifier} (${escapedColumns}) VALUES ${rowPlaceholders} ON DUPLICATE KEY UPDATE ${updateColumns}`
        : `INSERT INTO ${identifier} (${escapedColumns}) VALUES ${rowPlaceholders} ON DUPLICATE KEY UPDATE ${escapedColumns
            .split(', ')
            .map((c) => `${c} = ${c}`)
            .join(', ')}`;

      await pool.query(sql, values);

      logger.debug(`Upserted ${rows.length} rows to ${schema}.${table}`);
    } catch (error) {
      throw new DatabaseQueryError(`Failed to upsert rows to ${schema}.${table}`, error);
    }
  }

  async truncateTable(schema: string, table: string): Promise<void> {
    const pool = this.getPool();
    const identifier = `\`${schema}\`.\`${table}\``;

    try {
      await pool.query(`TRUNCATE TABLE ${identifier}`);
      logger.debug(`Truncated table ${schema}.${table}`);
    } catch (error) {
      throw new DatabaseQueryError(`Failed to truncate table ${schema}.${table}`, error);
    }
  }

  async tableExists(schema: string, table: string): Promise<boolean> {
    const pool = this.getPool();
    try {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        'SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1',
        [schema, table],
      );
      return rows.length > 0;
    } catch (error) {
      throw new DatabaseQueryError(`Failed to check table existence: ${schema}.${table}`, error);
    }
  }

  async createTable(schema: string, table: string, columns: ColumnInfo[]): Promise<void> {
    const pool = this.getPool();
    const identifier = `\`${schema}\`.\`${table}\``;

    try {
      const columnDefs = columns.map((col) => {
        const parts = [`\`${col.name}\``, col.dataType];
        if (!col.nullable) parts.push('NOT NULL');
        if (col.defaultValue !== null) parts.push(`DEFAULT ${col.defaultValue}`);
        return parts.join(' ');
      });

      const primaryKeys = columns.filter((c) => c.isPrimaryKey).map((c) => `\`${c.name}\``);
      if (primaryKeys.length > 0) {
        columnDefs.push(`PRIMARY KEY (${primaryKeys.join(', ')})`);
      }

      await pool.query(`CREATE TABLE ${identifier} (${columnDefs.join(', ')})`);
      logger.debug(`Created table ${schema}.${table}`);
    } catch (error) {
      throw new DatabaseQueryError(`Failed to create table ${schema}.${table}`, error);
    }
  }

  async destroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      logger.debug('MySQL connection pool destroyed');
    }
  }

  private getPool(): Pool {
    if (!this.pool) {
      throw new DatabaseConnectionError('Not connected. Call connect() first.');
    }
    return this.pool;
  }

  private async getForeignKeyColumnNames(
    pool: Pool,
    schema: string,
    table: string,
  ): Promise<Set<string>> {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [schema, table],
    );
    return new Set(rows.map((row) => row['COLUMN_NAME'] as string));
  }
}
