import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShinobiConfig, TableMaskConfig } from '../../config/types.js';
import type { DatabaseConnectionConfig } from '../../shared/types.js';

export interface TempDirHandle {
  path: string;
  cleanup: () => Promise<void>;
}

export async function createTempDir(): Promise<TempDirHandle> {
  const path = await mkdtemp(join(tmpdir(), 'shinobidb-e2e-'));
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

export async function readSyncState(syncStateDir: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(join(syncStateDir, '.shinobidb', 'sync-state.json'), 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildIncrementalConfig(
  source: DatabaseConnectionConfig,
  target: DatabaseConnectionConfig,
  tables: TableMaskConfig[],
  options?: Partial<ShinobiConfig['options']>,
): ShinobiConfig {
  return {
    version: '1',
    source,
    target,
    options: {
      batchSize: 1000,
      deterministic: true,
      seed: 'e2e-test-seed',
      truncateTarget: true,
      ...options,
    },
    tables,
  };
}
