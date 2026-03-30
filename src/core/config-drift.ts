import type { ShinobiConfig, TableMaskConfig } from '../config/types.js';
import type { DatabaseAdapter } from '../db/types.js';
import type { PiiDetectionResult } from '../detection/types.js';
import { logger } from '../shared/logger.js';

import type { ScanResult } from './scanner.js';

// --- Types ---

export type DriftSeverity = 'critical' | 'warning' | 'info';

export type DriftItemType =
  | 'copyonly_has_pii'
  | 'new_pii_column'
  | 'column_not_in_db'
  | 'table_not_in_db'
  | 'strategy_mismatch';

export interface DriftItem {
  type: DriftItemType;
  severity: DriftSeverity;
  schema: string;
  table: string;
  column?: string;
  message: string;
  detection?: PiiDetectionResult;
  configStrategy?: string;
}

export interface DriftResult {
  items: DriftItem[];
  hasActionableDrift: boolean;
  summary: { critical: number; warning: number; info: number };
}

// --- Functions ---

export function parseIgnoreList(ignore?: string[]): Set<string> {
  if (!ignore) return new Set();
  return new Set(ignore);
}

export async function buildSchemaMap(
  adapter: DatabaseAdapter,
  schemas: string[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();

  for (const schema of schemas) {
    const tables = await adapter.getTables(schema);
    for (const table of tables) {
      const columns = await adapter.getColumns(schema, table);
      const columnNames = new Set(columns.map((c) => c.name));
      map.set(`${schema}.${table}`, columnNames);
    }
  }

  return map;
}

export function detectDrift(
  config: ShinobiConfig,
  scanResult: ScanResult,
  schemaMap: Map<string, Set<string>>,
  options?: { minConfidence?: number },
): DriftResult {
  const minConfidence = options?.minConfidence ?? 0.5;
  const ignoreSet = parseIgnoreList(config.ignore);
  const items: DriftItem[] = [];

  const filteredDetections = scanResult.detections.filter((d) => d.confidence >= minConfidence);

  // Build config lookup: "schema.table.column" -> strategy
  const configColumnMap = new Map<string, string>();
  const configTableMap = new Map<string, TableMaskConfig>();
  for (const table of config.tables) {
    const tableKey = `${table.schema}.${table.table}`;
    configTableMap.set(tableKey, table);
    if (!table.copyOnly) {
      for (const col of table.columns) {
        configColumnMap.set(`${tableKey}.${col.name}`, col.strategy);
      }
    }
  }

  // Build detection lookup: "schema.table.column" -> detection
  const detectionMap = new Map<string, PiiDetectionResult>();
  for (const d of filteredDetections) {
    detectionMap.set(`${d.schema}.${d.table}.${d.column}`, d);
  }

  // Track columns reported by Case 1 to avoid duplicate in Case 2
  const reportedColumns = new Set<string>();

  // Case 1: copyOnly tables with PII detected
  for (const table of config.tables) {
    if (!table.copyOnly) continue;
    const tableKey = `${table.schema}.${table.table}`;

    for (const [detKey, detection] of detectionMap) {
      if (!detKey.startsWith(`${tableKey}.`)) continue;
      const colKey = detKey;
      if (ignoreSet.has(colKey)) continue;

      reportedColumns.add(colKey);
      items.push({
        type: 'copyonly_has_pii',
        severity: 'critical',
        schema: detection.schema,
        table: detection.table,
        column: detection.column,
        message: `copyOnly table has PII: ${colKey} [${detection.category}]`,
        detection,
      });
    }
  }

  // Case 2: New PII columns not in config
  for (const [detKey, detection] of detectionMap) {
    if (reportedColumns.has(detKey)) continue;
    if (ignoreSet.has(detKey)) continue;
    if (configColumnMap.has(detKey)) continue;

    // Also skip if the table is not in config at all but has been scanned
    // This IS a drift — the table exists in DB with PII but is not in config
    items.push({
      type: 'new_pii_column',
      severity: 'warning',
      schema: detection.schema,
      table: detection.table,
      column: detection.column,
      message: `New PII column not in config: ${detKey} [${detection.category}]`,
      detection,
    });
  }

  // Case 3: Config columns no longer in DB
  for (const table of config.tables) {
    if (table.copyOnly) continue;
    const tableKey = `${table.schema}.${table.table}`;
    const dbColumns = schemaMap.get(tableKey);
    if (!dbColumns) continue; // Case 4 handles missing tables

    for (const col of table.columns) {
      if (!dbColumns.has(col.name)) {
        items.push({
          type: 'column_not_in_db',
          severity: 'warning',
          schema: table.schema,
          table: table.table,
          column: col.name,
          message: `Config column no longer in database: ${tableKey}.${col.name}`,
        });
      }
    }
  }

  // Case 4: Config tables no longer in DB
  for (const table of config.tables) {
    const tableKey = `${table.schema}.${table.table}`;
    if (!schemaMap.has(tableKey)) {
      items.push({
        type: 'table_not_in_db',
        severity: 'warning',
        schema: table.schema,
        table: table.table,
        message: `Config table no longer in database: ${tableKey}`,
      });
    }
  }

  // Case 5: Strategy mismatch (info only)
  for (const [detKey, detection] of detectionMap) {
    const configStrategy = configColumnMap.get(detKey);
    if (!configStrategy) continue;
    if (configStrategy === detection.suggestedMaskingStrategy) continue;

    items.push({
      type: 'strategy_mismatch',
      severity: 'info',
      schema: detection.schema,
      table: detection.table,
      column: detection.column,
      message: `Strategy mismatch: config uses "${configStrategy}", scan suggests "${detection.suggestedMaskingStrategy}"`,
      detection,
      configStrategy,
    });
  }

  const summary = { critical: 0, warning: 0, info: 0 };
  for (const item of items) {
    summary[item.severity]++;
  }

  logger.info(
    `Drift detection complete: ${summary.critical} critical, ${summary.warning} warning, ${summary.info} info`,
  );

  return {
    items,
    hasActionableDrift: items.some((i) => i.severity !== 'info'),
    summary,
  };
}
