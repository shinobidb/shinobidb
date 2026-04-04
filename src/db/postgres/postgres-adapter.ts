import pg from 'pg';

import { DatabaseConnectionError, DatabaseQueryError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import type { DatabaseConnectionConfig } from '../../shared/types.js';
import {
  assertValidFilterOperator,
  validateDefaultValue,
  type ColumnInfo,
  type DatabaseAdapter,
  type ForeignKeyInfo,
  type ReadFilter,
} from '../types.js';

export class PostgresAdapter implements DatabaseAdapter {
  private pool: pg.Pool | null = null;
  private readonly config: DatabaseConnectionConfig;

  constructor(config: DatabaseConnectionConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      this.pool = new pg.Pool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
        max: 5,
      });

      const client = await this.pool.connect();
      client.release();
      logger.debug('PostgreSQL connection pool created');
    } catch (error) {
      throw new DatabaseConnectionError(
        `Failed to connect to PostgreSQL at ${this.config.host}:${this.config.port}`,
        error,
      );
    }
  }

  async getSchemas(): Promise<string[]> {
    const pool = this.getPool();
    try {
      const result = await pool.query(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         ORDER BY schema_name`,
      );
      return result.rows.map((row: Record<string, unknown>) => row['schema_name'] as string);
    } catch (error) {
      throw new DatabaseQueryError('Failed to retrieve schemas', error);
    }
  }

  async getTables(schema: string): Promise<string[]> {
    const pool = this.getPool();
    try {
      const result = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = $2
         ORDER BY table_name`,
        [schema, 'BASE TABLE'],
      );
      return result.rows.map((row: Record<string, unknown>) => row['table_name'] as string);
    } catch (error) {
      throw new DatabaseQueryError(`Failed to retrieve tables for schema: ${schema}`, error);
    }
  }

  async getColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const pool = this.getPool();
    try {
      const columnsResult = await pool.query(
        `SELECT
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_primary_key
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name
            AND tc.table_schema = ku.table_schema
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
        ) pk ON c.column_name = pk.column_name
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position`,
        [schema, table],
      );

      const foreignKeyColumns = await this.getForeignKeyColumnNames(pool, schema, table);

      return columnsResult.rows.map((col: Record<string, unknown>) => ({
        name: col['column_name'] as string,
        dataType: col['data_type'] as string,
        nullable: col['is_nullable'] === 'YES',
        isPrimaryKey: col['is_primary_key'] as boolean,
        isForeignKey: foreignKeyColumns.has(col['column_name'] as string),
        defaultValue: (col['column_default'] as string | null) ?? null,
        comment: null,
      }));
    } catch (error) {
      throw new DatabaseQueryError(`Failed to retrieve columns for ${schema}.${table}`, error);
    }
  }

  async getRowCount(schema: string, table: string): Promise<number> {
    const pool = this.getPool();
    try {
      const result = await pool.query(
        `SELECT reltuples::bigint AS estimate
         FROM pg_class
         JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
         WHERE pg_namespace.nspname = $1 AND pg_class.relname = $2`,
        [schema, table],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return 0;
      const estimate = Number(row['estimate']);
      return estimate < 0 ? 0 : estimate;
    } catch (error) {
      throw new DatabaseQueryError(`Failed to get row count for ${schema}.${table}`, error);
    }
  }

  async getForeignKeys(schema: string, table: string): Promise<ForeignKeyInfo[]> {
    const pool = this.getPool();
    try {
      const result = await pool.query(
        `SELECT
          kcu.column_name,
          ccu.table_schema AS referenced_table_schema,
          ccu.table_name AS referenced_table_name,
          ccu.column_name AS referenced_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema = ccu.table_schema
        WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'`,
        [schema, table],
      );

      return result.rows.map((row: Record<string, unknown>) => ({
        column: row['column_name'] as string,
        referencedSchema: row['referenced_table_schema'] as string,
        referencedTable: row['referenced_table_name'] as string,
        referencedColumn: row['referenced_column_name'] as string,
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
    const identifier = `"${schema}"."${table}"`;
    let offset = 0;

    try {
      while (true) {
        let sql: string;
        let params: unknown[];

        if (filter) {
          assertValidFilterOperator(filter.operator);
          sql = `SELECT * FROM ${identifier} WHERE "${filter.column}" ${filter.operator} $1 ORDER BY "${filter.column}" ASC LIMIT $2 OFFSET $3`;
          params = [filter.value, batchSize, offset];
        } else {
          sql = `SELECT * FROM ${identifier} LIMIT $1 OFFSET $2`;
          params = [batchSize, offset];
        }

        const result = await pool.query(sql, params);

        if (result.rows.length === 0) break;

        const shouldContinue = await onBatch(result.rows as Record<string, unknown>[]);
        if (shouldContinue === false) break;

        if (result.rows.length < batchSize) break;
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
    const identifier = `"${schema}"."${table}"`;

    try {
      const firstRow = rows[0]!;
      const columnNames = Object.keys(firstRow);
      const escapedColumns = columnNames.map((c) => `"${c}"`).join(', ');

      let paramIndex = 1;
      const rowPlaceholders = rows
        .map(() => {
          const placeholders = columnNames.map(() => `$${paramIndex++}`).join(', ');
          return `(${placeholders})`;
        })
        .join(', ');
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
    const identifier = `"${schema}"."${table}"`;
    const pkColumns = Array.isArray(primaryKey) ? primaryKey : [primaryKey];

    try {
      const firstRow = rows[0]!;
      const columnNames = Object.keys(firstRow);
      const escapedColumns = columnNames.map((c) => `"${c}"`).join(', ');
      const conflictColumns = pkColumns.map((c) => `"${c}"`).join(', ');

      let paramIndex = 1;
      const rowPlaceholders = rows
        .map(() => {
          const placeholders = columnNames.map(() => `$${paramIndex++}`).join(', ');
          return `(${placeholders})`;
        })
        .join(', ');
      const values = rows.flatMap((row) => columnNames.map((col) => row[col] ?? null));

      const updateColumns = columnNames
        .filter((c) => !pkColumns.includes(c))
        .map((c) => `"${c}" = EXCLUDED."${c}"`)
        .join(', ');

      const sql = updateColumns
        ? `INSERT INTO ${identifier} (${escapedColumns}) VALUES ${rowPlaceholders} ON CONFLICT (${conflictColumns}) DO UPDATE SET ${updateColumns}`
        : `INSERT INTO ${identifier} (${escapedColumns}) VALUES ${rowPlaceholders} ON CONFLICT (${conflictColumns}) DO NOTHING`;

      await pool.query(sql, values);

      logger.debug(`Upserted ${rows.length} rows to ${schema}.${table}`);
    } catch (error) {
      throw new DatabaseQueryError(`Failed to upsert rows to ${schema}.${table}`, error);
    }
  }

  async updateRows(
    schema: string,
    table: string,
    rows: Record<string, unknown>[],
    primaryKey: string | string[],
  ): Promise<void> {
    if (rows.length === 0) return;

    const pool = this.getPool();
    const identifier = `"${schema}"."${table}"`;
    const pkColumns = Array.isArray(primaryKey) ? primaryKey : [primaryKey];

    try {
      const firstRow = rows[0]!;
      const updateColumns = Object.keys(firstRow).filter((c) => !pkColumns.includes(c));

      if (updateColumns.length === 0) return;

      // Use transaction with individual UPDATEs for safety
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          let paramIndex = 1;
          const setClause = updateColumns.map((c) => `"${c}" = $${paramIndex++}`).join(', ');
          const whereClause = pkColumns.map((c) => `"${c}" = $${paramIndex++}`).join(' AND ');
          const values = [
            ...updateColumns.map((c) => row[c] ?? null),
            ...pkColumns.map((c) => row[c]),
          ];
          await client.query(`UPDATE ${identifier} SET ${setClause} WHERE ${whereClause}`, values);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      logger.debug(`Updated ${rows.length} rows in ${schema}.${table}`);
    } catch (error) {
      throw new DatabaseQueryError(`Failed to update rows in ${schema}.${table}`, error);
    }
  }

  async truncateTable(schema: string, table: string): Promise<void> {
    const pool = this.getPool();
    const identifier = `"${schema}"."${table}"`;

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
      const result = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
        [schema, table],
      );
      return result.rows.length > 0;
    } catch (error) {
      throw new DatabaseQueryError(`Failed to check table existence: ${schema}.${table}`, error);
    }
  }

  async createTable(schema: string, table: string, columns: ColumnInfo[]): Promise<void> {
    const pool = this.getPool();
    const identifier = `"${schema}"."${table}"`;

    try {
      const columnDefs = columns.map((col) => {
        // Convert SERIAL-like columns (integer + nextval default) back to SERIAL
        if (
          col.defaultValue !== null &&
          typeof col.defaultValue === 'string' &&
          col.defaultValue.startsWith('nextval(')
        ) {
          const serialType = col.dataType === 'bigint' ? 'BIGSERIAL' : 'SERIAL';
          return `"${col.name}" ${serialType}${col.nullable ? '' : ' NOT NULL'}`;
        }

        const parts = [`"${col.name}"`, col.dataType];
        if (!col.nullable) parts.push('NOT NULL');
        if (col.defaultValue !== null) {
          if (validateDefaultValue(col.defaultValue)) {
            parts.push(`DEFAULT ${col.defaultValue}`);
          } else {
            logger.warn(`Skipping suspicious DEFAULT value for ${schema}.${table}.${col.name}`);
          }
        }
        return parts.join(' ');
      });

      const primaryKeys = columns.filter((c) => c.isPrimaryKey).map((c) => `"${c.name}"`);
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
      logger.debug('PostgreSQL connection pool destroyed');
    }
  }

  private getPool(): pg.Pool {
    if (!this.pool) {
      throw new DatabaseConnectionError('Not connected. Call connect() first.');
    }
    return this.pool;
  }

  private async getForeignKeyColumnNames(
    pool: pg.Pool,
    schema: string,
    table: string,
  ): Promise<Set<string>> {
    const result = await pool.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'`,
      [schema, table],
    );
    return new Set(result.rows.map((row: Record<string, unknown>) => row['column_name'] as string));
  }
}
