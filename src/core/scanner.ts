import type { DatabaseAdapter, TableInfo } from '../db/types.js';
import type { PiiDetectionResult, PiiDetector } from '../detection/types.js';
import { logger } from '../shared/logger.js';

export interface ScanOptions {
  schemas?: string[];
  tables?: string[];
}

export interface ScannedTable {
  schema: string;
  table: string;
}

export interface ScanResult {
  detections: PiiDetectionResult[];
  tablesScanned: number;
  columnsScanned: number;
  scannedTables: ScannedTable[];
}

export async function scan(
  adapter: DatabaseAdapter,
  detectors: PiiDetector[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const schemas = options.schemas ?? (await adapter.getSchemas());
  logger.info(`Scanning ${schemas.length} schema(s): ${schemas.join(', ')}`);

  const allTables: TableInfo[] = [];

  for (const schema of schemas) {
    const tableNames = await adapter.getTables(schema);
    const filteredNames = options.tables
      ? tableNames.filter((t) => options.tables!.includes(t))
      : tableNames;

    logger.debug(`Schema "${schema}": ${filteredNames.length} table(s) to scan`);

    for (const tableName of filteredNames) {
      const [columns, foreignKeys, estimatedRowCount] = await Promise.all([
        adapter.getColumns(schema, tableName),
        adapter.getForeignKeys(schema, tableName),
        adapter.getRowCount(schema, tableName),
      ]);

      allTables.push({
        schema,
        name: tableName,
        columns,
        foreignKeys,
        estimatedRowCount,
      });
    }
  }

  let totalColumns = 0;
  for (const table of allTables) {
    totalColumns += table.columns.length;
  }

  logger.info(`Found ${allTables.length} table(s), ${totalColumns} column(s) total`);

  const rawDetections: PiiDetectionResult[] = [];

  for (const detector of detectors) {
    const detections = await detector.detect(allTables);
    rawDetections.push(...detections);
  }

  // Deduplicate: when multiple detectors find the same column, keep highest confidence
  const deduped = new Map<string, PiiDetectionResult>();
  for (const d of rawDetections) {
    const key = `${d.schema}.${d.table}.${d.column}`;
    const existing = deduped.get(key);
    if (!existing || d.confidence > existing.confidence) {
      deduped.set(key, d);
    }
  }
  const allDetections = Array.from(deduped.values());

  logger.success(`Scan complete: ${allDetections.length} PII column(s) detected`);

  return {
    detections: allDetections,
    tablesScanned: allTables.length,
    columnsScanned: totalColumns,
    scannedTables: allTables.map((t) => ({ schema: t.schema, table: t.name })),
  };
}
