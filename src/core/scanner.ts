import type { DatabaseAdapter, TableInfo } from '../db/types.js';
import type { PiiDetectionResult, PiiDetector } from '../detection/types.js';
import { logger } from '../shared/logger.js';

export interface ScanOptions {
  schemas?: string[];
  tables?: string[];
}

export interface ScanResult {
  detections: PiiDetectionResult[];
  tablesScanned: number;
  columnsScanned: number;
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

  const allDetections: PiiDetectionResult[] = [];

  for (const detector of detectors) {
    const detections = await detector.detect(allTables);
    allDetections.push(...detections);
  }

  logger.success(`Scan complete: ${allDetections.length} PII column(s) detected`);

  return {
    detections: allDetections,
    tablesScanned: allTables.length,
    columnsScanned: totalColumns,
  };
}
