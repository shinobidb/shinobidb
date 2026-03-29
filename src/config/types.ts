import type { DatabaseConnectionConfig } from '../shared/types.js';

export interface ColumnMaskConfig {
  name: string;
  strategy: string;
  params?: Record<string, unknown>;
}

export interface IncrementalConfig {
  strategy: 'timestamp' | 'cursor';
  column: string;
}

export interface TableMaskConfig {
  schema: string;
  table: string;
  columns: ColumnMaskConfig[];
  copyOnly?: boolean;
  incremental?: IncrementalConfig;
}

export interface MaskOptions {
  batchSize: number;
  deterministic: boolean;
  seed: string;
  truncateTarget: boolean;
}

export interface ShinobiConfig {
  version: '1';
  source: DatabaseConnectionConfig;
  target: DatabaseConnectionConfig;
  options: MaskOptions;
  tables: TableMaskConfig[];
  customStrategies?: string[];
}
