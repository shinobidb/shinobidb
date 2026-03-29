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
