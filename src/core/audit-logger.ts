import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';

import type { ShinobiConfig } from '../config/types.js';
import { logger } from '../shared/logger.js';

import type { MaskResult, TableResult } from './mask-executor.js';

export interface AuditRecord {
  timestamp: string;
  durationMs: number;
  source: { type: string; host: string; database?: string };
  target: { type: string; host: string; database?: string };
  options: {
    syncSchema: boolean;
    concurrency: number;
    deterministic: boolean;
    truncateTarget: boolean;
  };
  tables: TableResult[];
  totals: {
    tablesProcessed: number;
    rowsProcessed: number;
    rowsWritten: number;
  };
}

export interface AuditLogInput {
  config: ShinobiConfig;
  result: MaskResult;
  durationMs: number;
  syncSchema?: boolean;
  concurrency?: number;
}

export function buildAuditRecord(input: AuditLogInput): AuditRecord {
  const { config, result, durationMs } = input;

  return {
    timestamp: new Date().toISOString(),
    durationMs,
    source: {
      type: config.source.type,
      host: config.source.host,
      database: config.source.database,
    },
    target: {
      type: config.target.type,
      host: config.target.host,
      database: config.target.database,
    },
    options: {
      syncSchema: input.syncSchema ?? false,
      concurrency: input.concurrency ?? 1,
      deterministic: config.options.deterministic,
      truncateTarget: config.options.truncateTarget,
    },
    tables: result.tableDetails,
    totals: {
      tablesProcessed: result.tablesProcessed,
      rowsProcessed: result.rowsProcessed,
      rowsWritten: result.rowsWritten,
    },
  };
}

export async function writeAuditLog(filePath: string, record: AuditRecord): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const ext = extname(filePath).toLowerCase();

  if (ext === '.csv') {
    await writeCsvAuditLog(filePath, record);
  } else {
    await writeJsonAuditLog(filePath, record);
  }

  logger.success(`Audit log written to ${filePath}`);
}

async function writeJsonAuditLog(filePath: string, record: AuditRecord): Promise<void> {
  let records: AuditRecord[] = [];

  if (existsSync(filePath)) {
    const content = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      records = parsed as AuditRecord[];
    }
  }

  records.push(record);
  await writeFile(filePath, JSON.stringify(records, null, 2) + '\n', 'utf-8');
}

const CSV_HEADERS = [
  'timestamp',
  'duration_ms',
  'source_type',
  'source_host',
  'source_database',
  'target_type',
  'target_host',
  'target_database',
  'tables_processed',
  'rows_processed',
  'rows_written',
  'sync_schema',
  'concurrency',
  'deterministic',
  'truncate_target',
] as const;

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function auditRecordToCsvRow(record: AuditRecord): string {
  const values: string[] = [
    record.timestamp,
    String(record.durationMs),
    record.source.type,
    record.source.host,
    record.source.database ?? '',
    record.target.type,
    record.target.host,
    record.target.database ?? '',
    String(record.totals.tablesProcessed),
    String(record.totals.rowsProcessed),
    String(record.totals.rowsWritten),
    String(record.options.syncSchema),
    String(record.options.concurrency),
    String(record.options.deterministic),
    String(record.options.truncateTarget),
  ];
  return values.map(escapeCsvField).join(',');
}

async function writeCsvAuditLog(filePath: string, record: AuditRecord): Promise<void> {
  const fileExists = existsSync(filePath);
  const row = auditRecordToCsvRow(record);

  if (fileExists) {
    const existing = await readFile(filePath, 'utf-8');
    await writeFile(filePath, existing.trimEnd() + '\n' + row + '\n', 'utf-8');
  } else {
    await writeFile(filePath, CSV_HEADERS.join(',') + '\n' + row + '\n', 'utf-8');
  }
}
