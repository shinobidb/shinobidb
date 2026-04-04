import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { open, unlink } from 'node:fs/promises';

import pg from 'pg';

import { ShinobiError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import type { DatabaseConnectionConfig } from '../shared/types.js';

import type { DumpRestoreProvider, SwapProvider } from './types.js';

function buildPgEnv(config: DatabaseConnectionConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGPASSWORD: config.password,
  };
}

function buildPgArgs(config: DatabaseConnectionConfig): string[] {
  return [`--host=${config.host}`, `--port=${String(config.port)}`, `--username=${config.user}`];
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', [command], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function spawnAndWait(
  command: string,
  args: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    stdout?: NodeJS.WritableStream;
    stdin?: NodeJS.ReadableStream;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options?.env ?? process.env,
    });

    let stdout = '';
    let stderr = '';
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    if (options?.stdin) {
      options.stdin.pipe(proc.stdin);
    } else {
      proc.stdin.end();
    }

    if (options?.stdout) {
      proc.stdout.pipe(options.stdout);
    } else {
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
    }

    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    proc.on('error', reject);
  });
}

/**
 * Connect to the 'postgres' maintenance database for admin operations
 * (CREATE DATABASE, DROP DATABASE, ALTER DATABASE RENAME).
 */
async function connectMaintenance(config: DatabaseConnectionConfig): Promise<pg.Client> {
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: 'postgres',
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  return client;
}

/**
 * Terminate all active connections to a database.
 * Required before DROP DATABASE or ALTER DATABASE RENAME.
 */
async function terminateConnections(client: pg.Client, dbName: string): Promise<void> {
  await client.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName],
  );
}

export class PostgresDumpRestore implements DumpRestoreProvider {
  async assertToolsAvailable(): Promise<void> {
    const [hasPgDump, hasPsql] = await Promise.all([
      commandExists('pg_dump'),
      commandExists('psql'),
    ]);

    const missing: string[] = [];
    if (!hasPgDump) missing.push('pg_dump');
    if (!hasPsql) missing.push('psql');

    if (missing.length > 0) {
      throw new ShinobiError(
        `Required tools not found: ${missing.join(', ')}. ` +
          'Install PostgreSQL client tools: ' +
          'macOS: brew install libpq | ' +
          'Ubuntu/Debian: apt-get install postgresql-client | ' +
          'Docker: use postgres:16 image which includes client tools.',
        'MISSING_TOOLS',
      );
    }
  }

  async createDatabase(config: DatabaseConnectionConfig, dbName: string): Promise<void> {
    const client = await connectMaintenance(config);
    try {
      // Use template0 to avoid encoding/locale conflicts
      await client.query(`CREATE DATABASE "${dbName}" TEMPLATE template0`);
      logger.debug(`Created database: ${dbName}`);
    } finally {
      await client.end();
    }
  }

  async dump(source: DatabaseConnectionConfig, outputPath: string): Promise<void> {
    const args = [
      ...buildPgArgs(source),
      '--no-owner',
      '--no-acl',
      '--format=plain',
      source.database!,
    ];

    const fileStream = createWriteStream(outputPath);
    try {
      const result = await spawnAndWait('pg_dump', args, {
        env: buildPgEnv(source),
        stdout: fileStream,
      });

      if (result.exitCode !== 0) {
        await unlink(outputPath).catch(() => {});
        throw new ShinobiError(
          `pg_dump failed (exit code ${result.exitCode}): ${result.stderr.trim()}`,
          'DUMP_FAILED',
        );
      }

      logger.debug(`Dump written to ${outputPath}`);
    } finally {
      fileStream.end();
    }
  }

  async restore(
    target: DatabaseConnectionConfig,
    targetDbName: string,
    inputPath: string,
  ): Promise<void> {
    const fh = await open(inputPath, 'r');
    const fileStream = fh.createReadStream();

    try {
      const args = [...buildPgArgs(target), '--dbname', targetDbName];
      const result = await spawnAndWait('psql', args, {
        env: buildPgEnv(target),
        stdin: fileStream,
      });

      if (result.exitCode !== 0) {
        throw new ShinobiError(
          `psql restore failed (exit code ${result.exitCode}): ${result.stderr.trim()}`,
          'RESTORE_FAILED',
        );
      }

      logger.debug(`Restored dump to ${targetDbName}`);
    } finally {
      await fh.close();
    }
  }

  async dropDatabase(config: DatabaseConnectionConfig, dbName: string): Promise<void> {
    const client = await connectMaintenance(config);
    try {
      await terminateConnections(client, dbName);
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      logger.debug(`Dropped database: ${dbName}`);
    } finally {
      await client.end();
    }
  }

  async databaseExists(config: DatabaseConnectionConfig, dbName: string): Promise<boolean> {
    const client = await connectMaintenance(config);
    try {
      const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
      return result.rows.length > 0;
    } finally {
      await client.end();
    }
  }

  getTempSchema(sourceSchema: string, _tempDbName: string): string {
    // PostgreSQL: schema name stays the same (e.g. 'public'), only the database changes
    return sourceSchema;
  }
}

export class PostgresSwap implements SwapProvider {
  /**
   * Swap databases by renaming:
   * 1. Terminate all connections to target and temp
   * 2. ALTER DATABASE target RENAME TO old
   * 3. ALTER DATABASE temp RENAME TO target
   *
   * This is simpler than MySQL's table-by-table RENAME because the entire
   * database (including views, functions, triggers) moves atomically.
   */
  async swap(
    config: DatabaseConnectionConfig,
    targetDb: string,
    tempDb: string,
    oldDb: string,
  ): Promise<void> {
    const client = await connectMaintenance(config);
    try {
      // Terminate all connections to both databases
      await terminateConnections(client, targetDb);
      await terminateConnections(client, tempDb);

      // Rename target → old, then temp → target
      await client.query(`ALTER DATABASE "${targetDb}" RENAME TO "${oldDb}"`);
      await client.query(`ALTER DATABASE "${tempDb}" RENAME TO "${targetDb}"`);

      logger.debug(`Swapped: ${tempDb} → ${targetDb}, old → ${oldDb}`);
    } finally {
      await client.end();
    }
  }
}
