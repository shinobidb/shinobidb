import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseConnectionConfig } from '../../shared/types.js';
import {
  createEmptySyncState,
  createSourceFingerprint,
  getTableKey,
  loadSyncState,
  saveSyncState,
} from '../sync-state.js';
import type { SyncState } from '../sync-state.js';

describe('sync-state', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'shinobidb-sync-state-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('createSourceFingerprint', () => {
    it('should create deterministic fingerprint from connection config', () => {
      const config: DatabaseConnectionConfig = {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'secret',
        database: 'mydb',
      };

      const fp1 = createSourceFingerprint(config);
      const fp2 = createSourceFingerprint(config);

      expect(fp1).toBe(fp2);
      expect(fp1).toHaveLength(16);
    });

    it('should produce different fingerprints for different configs', () => {
      const config1: DatabaseConnectionConfig = {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'secret',
        database: 'db1',
      };

      const config2: DatabaseConnectionConfig = {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'secret',
        database: 'db2',
      };

      expect(createSourceFingerprint(config1)).not.toBe(createSourceFingerprint(config2));
    });

    it('should not include password in fingerprint', () => {
      const config1: DatabaseConnectionConfig = {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'pass1',
        database: 'mydb',
      };

      const config2: DatabaseConnectionConfig = {
        ...config1,
        password: 'pass2',
      };

      expect(createSourceFingerprint(config1)).toBe(createSourceFingerprint(config2));
    });
  });

  describe('loadSyncState', () => {
    it('should return null when file does not exist', async () => {
      const result = await loadSyncState(join(tempDir, 'nonexistent.json'));
      expect(result).toBeNull();
    });

    it('should load valid sync state', async () => {
      const state: SyncState = {
        version: 1,
        sourceFingerprint: 'abc123',
        tables: {
          'mydb.users': {
            strategy: 'timestamp',
            cursor: '2026-03-28T12:00:00Z',
            lastSyncedAt: '2026-03-29T00:00:00Z',
            rowsSynced: 1500,
          },
        },
      };

      const filePath = join(tempDir, 'sync-state.json');
      await writeFile(filePath, JSON.stringify(state), 'utf-8');

      const result = await loadSyncState(filePath);
      expect(result).toEqual(state);
    });

    it('should return null for unsupported version', async () => {
      const filePath = join(tempDir, 'sync-state.json');
      await writeFile(filePath, JSON.stringify({ version: 99, tables: {} }), 'utf-8');

      const result = await loadSyncState(filePath);
      expect(result).toBeNull();
    });

    it('should throw SYNC_STATE_CORRUPTED for invalid JSON', async () => {
      const filePath = join(tempDir, 'sync-state.json');
      await writeFile(filePath, '{broken', 'utf-8');

      await expect(loadSyncState(filePath)).rejects.toThrow('corrupted');
    });
  });

  describe('saveSyncState', () => {
    it('should write sync state to file', async () => {
      const state: SyncState = {
        version: 1,
        sourceFingerprint: 'abc123',
        tables: {
          'mydb.users': {
            strategy: 'cursor',
            cursor: '5000',
            lastSyncedAt: '2026-03-29T00:00:00Z',
            rowsSynced: 5000,
          },
        },
      };

      const filePath = join(tempDir, 'sync-state.json');
      await saveSyncState(filePath, state);

      const content = await readFile(filePath, 'utf-8');
      expect(JSON.parse(content)).toEqual(state);
    });

    it('should create parent directories if they do not exist', async () => {
      const state = createEmptySyncState('fp123');
      const filePath = join(tempDir, 'nested', 'dir', 'sync-state.json');

      await saveSyncState(filePath, state);

      const content = await readFile(filePath, 'utf-8');
      expect(JSON.parse(content)).toEqual(state);
    });
  });

  describe('createEmptySyncState', () => {
    it('should create state with given fingerprint and empty tables', () => {
      const state = createEmptySyncState('fp123');

      expect(state.version).toBe(1);
      expect(state.sourceFingerprint).toBe('fp123');
      expect(state.tables).toEqual({});
    });
  });

  describe('getTableKey', () => {
    it('should combine schema and table with dot', () => {
      expect(getTableKey('mydb', 'users')).toBe('mydb.users');
    });
  });
});
