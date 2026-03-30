export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  defaultValue: string | null;
  comment: string | null;
}

export interface ForeignKeyInfo {
  column: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  estimatedRowCount: number;
}

export interface ReadFilter {
  column: string;
  operator: '>' | '>=';
  value: string | number | Date;
  orderBy: 'ASC';
}

const DANGEROUS_DEFAULT_PATTERN = /;|--|\*\/|\/\*/;

/**
 * Validate a column DEFAULT value before interpolating into DDL.
 * Rejects values containing SQL statement separators or comment syntax.
 */
export function validateDefaultValue(value: string): boolean {
  return !DANGEROUS_DEFAULT_PATTERN.test(value);
}

const VALID_FILTER_OPERATORS = new Set(['>', '>=']);

/**
 * Runtime assertion that a filter operator is one of the allowed values.
 * Prevents injection even if TypeScript type narrowing is bypassed at runtime.
 */
export function assertValidFilterOperator(operator: string): asserts operator is '>' | '>=' {
  if (!VALID_FILTER_OPERATORS.has(operator)) {
    throw new Error(`Invalid filter operator: ${operator}`);
  }
}

export interface DatabaseAdapter {
  connect(): Promise<void>;

  getSchemas(): Promise<string[]>;

  getTables(schema: string): Promise<string[]>;

  getColumns(schema: string, table: string): Promise<ColumnInfo[]>;

  getRowCount(schema: string, table: string): Promise<number>;

  getForeignKeys(schema: string, table: string): Promise<ForeignKeyInfo[]>;

  readRows(
    schema: string,
    table: string,
    batchSize: number,
    onBatch: (rows: Record<string, unknown>[]) => Promise<boolean | void>,
    filter?: ReadFilter,
  ): Promise<void>;

  writeRows(schema: string, table: string, rows: Record<string, unknown>[]): Promise<void>;

  upsertRows(
    schema: string,
    table: string,
    rows: Record<string, unknown>[],
    primaryKey: string | string[],
  ): Promise<void>;

  truncateTable(schema: string, table: string): Promise<void>;

  tableExists(schema: string, table: string): Promise<boolean>;

  createTable(schema: string, table: string, columns: ColumnInfo[]): Promise<void>;

  destroy(): Promise<void>;
}
