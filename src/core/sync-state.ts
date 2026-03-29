import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ShinobiError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import type { DatabaseConnectionConfig } from '../shared/types.js';

export interface TableSyncState {
  strategy: 'timestamp' | 'cursor';
  cursor: string;
  lastSyncedAt: string;
  rowsSynced: number;
}

export interface SyncState {
  version: 1;
  sourceFingerprint: string;
  tables: Record<string, TableSyncState>;
}

const SYNC_STATE_DIR = '.shinobidb';
const SYNC_STATE_FILE = 'sync-state.json';

export function getSyncStatePath(baseDir: string = process.cwd()): string {
  return join(baseDir, SYNC_STATE_DIR, SYNC_STATE_FILE);
}

export function createSourceFingerprint(config: DatabaseConnectionConfig): string {
  const key = `${config.type}://${config.user}@${config.host}:${config.port}/${config.database ?? ''}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export async function loadSyncState(filePath: string): Promise<SyncState | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as SyncState;

    if (parsed.version !== 1) {
      logger.warn(`Unsupported sync state version: ${String(parsed.version)}, ignoring`);
      return null;
    }

    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    if (err instanceof SyntaxError) {
      throw new ShinobiError(
        `Sync state file is corrupted: ${filePath}. Delete the file or run with --full-refresh.`,
        'SYNC_STATE_CORRUPTED',
        err,
      );
    }
    throw err;
  }
}

export async function saveSyncState(filePath: string, state: SyncState): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
  logger.debug(`Sync state saved to ${filePath}`);
}

export function createEmptySyncState(fingerprint: string): SyncState {
  return {
    version: 1,
    sourceFingerprint: fingerprint,
    tables: {},
  };
}

export function getTableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}
