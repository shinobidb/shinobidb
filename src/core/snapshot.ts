import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ScanResult } from './scanner.js';

export async function saveSnapshot(filePath: string, result: ScanResult): Promise<void> {
  const data = {
    version: 1,
    timestamp: new Date().toISOString(),
    ...result,
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function loadSnapshot(filePath: string): Promise<ScanResult> {
  const raw = await readFile(filePath, 'utf-8');
  const data = JSON.parse(raw) as ScanResult & { version?: number; timestamp?: string };
  return {
    detections: data.detections,
    tablesScanned: data.tablesScanned,
    columnsScanned: data.columnsScanned,
    scannedTables: data.scannedTables ?? [],
  };
}
