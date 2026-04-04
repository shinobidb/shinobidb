import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { open, unlink } from 'node:fs/promises';

import mysql from 'mysql2/promise';

import { ShinobiError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import type { DatabaseConnectionConfig } from '../shared/types.js';

import type { DumpRestoreProvider, SwapProvider } from './types.js';

function buildConnectionArgs(config: DatabaseConnectionConfig): string[] {
  const args = [`--host=${config.host}`, `--port=${String(config.port)}`, `--user=${config.user}`];
  if (config.password) {
    args.push(`--password=${config.password}`);
  }
  if (config.ssl) {
    args.push('--ssl-mode=REQUIRED');
  }
  return args;
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
    stdout?: NodeJS.WritableStream;
    stdin?: NodeJS.ReadableStream;
  },
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
      proc.stdout.resume();
    }

    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stderr });
    });
    proc.on('error', reject);
  });
}

export class MySQLDumpRestore implements DumpRestoreProvider {
  async assertToolsAvailable(): Promise<void> {
    const [hasDump, hasMysql] = await Promise.all([
      commandExists('mysqldump'),
      commandExists('mysql'),
    ]);

    const missing: string[] = [];
    if (!hasDump) missing.push('mysqldump');
    if (!hasMysql) missing.push('mysql');

    if (missing.length > 0) {
      throw new ShinobiError(
        `Required tools not found: ${missing.join(', ')}. ` +
          'Install MySQL client tools: ' +
          'macOS: brew install mysql-client | ' +
          'Ubuntu/Debian: apt-get install mysql-client | ' +
          'Docker: use mysql:8 image which includes client tools.',
        'MISSING_TOOLS',
      );
    }
  }

  async createDatabase(config: DatabaseConnectionConfig, dbName: string): Promise<void> {
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? {} : undefined,
    });

    try {
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
      logger.debug(`Created database: ${dbName}`);
    } finally {
      await connection.end();
    }
  }

  async dump(source: DatabaseConnectionConfig, outputPath: string): Promise<void> {
    const args = [
      ...buildConnectionArgs(source),
      '--single-transaction',
      '--routines',
      '--triggers',
      '--events',
      '--set-gtid-purged=OFF',
      '--column-statistics=0',
      source.database!,
    ];

    const fileStream = createWriteStream(outputPath);
    try {
      const result = await spawnAndWait('mysqldump', args, { stdout: fileStream });

      if (result.exitCode !== 0) {
        // Clean up partial dump file
        await unlink(outputPath).catch(() => {});
        throw new ShinobiError(
          `mysqldump failed (exit code ${result.exitCode}): ${result.stderr.trim()}`,
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
    // Verify input file exists
    const fh = await open(inputPath, 'r');
    const fileStream = fh.createReadStream();

    try {
      const args = [...buildConnectionArgs(target), targetDbName];
      const result = await spawnAndWait('mysql', args, { stdin: fileStream });

      if (result.exitCode !== 0) {
        throw new ShinobiError(
          `mysql restore failed (exit code ${result.exitCode}): ${result.stderr.trim()}`,
          'RESTORE_FAILED',
        );
      }

      logger.debug(`Restored dump to ${targetDbName}`);
    } finally {
      await fh.close();
    }
  }

  async dropDatabase(config: DatabaseConnectionConfig, dbName: string): Promise<void> {
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? {} : undefined,
    });

    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      logger.debug(`Dropped database: ${dbName}`);
    } finally {
      await connection.end();
    }
  }

  async databaseExists(config: DatabaseConnectionConfig, dbName: string): Promise<boolean> {
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? {} : undefined,
    });

    try {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
        [dbName],
      );
      return rows.length > 0;
    } finally {
      await connection.end();
    }
  }
}

export class MySQLSwap implements SwapProvider {
  async swap(
    config: DatabaseConnectionConfig,
    targetDb: string,
    tempDb: string,
    oldDb: string,
  ): Promise<void> {
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? {} : undefined,
    });

    try {
      // Create the old database to hold displaced tables
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${oldDb}\``);

      // Get all tables from both target and temp databases
      const [targetTables] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?',
        [targetDb, 'BASE TABLE'],
      );
      const [tempTables] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?',
        [tempDb, 'BASE TABLE'],
      );

      if (tempTables.length === 0) {
        throw new ShinobiError(
          `Temp database "${tempDb}" has no tables. Dump/restore may have failed.`,
          'SWAP_FAILED',
        );
      }

      // Build atomic RENAME TABLE statement
      // Move target tables to old, then temp tables to target — all in one statement
      const renames: string[] = [];

      for (const row of targetTables) {
        const tableName = row['TABLE_NAME'] as string;
        renames.push(`\`${targetDb}\`.\`${tableName}\` TO \`${oldDb}\`.\`${tableName}\``);
      }
      for (const row of tempTables) {
        const tableName = row['TABLE_NAME'] as string;
        renames.push(`\`${tempDb}\`.\`${tableName}\` TO \`${targetDb}\`.\`${tableName}\``);
      }

      if (renames.length > 0) {
        // Disable FK checks for the swap to avoid constraint errors during rename
        await connection.query('SET FOREIGN_KEY_CHECKS = 0');
        await connection.query(`RENAME TABLE ${renames.join(', ')}`);
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
      }

      logger.debug(`Swapped: ${tempDb} → ${targetDb}, old → ${oldDb}`);

      // Handle views: recreate in target from temp definitions
      const [tempViews] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?',
        [tempDb, 'VIEW'],
      );

      for (const row of tempViews) {
        const viewName = row['TABLE_NAME'] as string;
        const [viewDefs] = await connection.query<mysql.RowDataPacket[]>(
          'SHOW CREATE VIEW `' + tempDb + '`.`' + viewName + '`',
        );
        if (viewDefs.length > 0) {
          let createViewSql = viewDefs[0]!['Create View'] as string;
          // Rewrite database references from temp to target
          createViewSql = createViewSql.replace(
            new RegExp(`\`${tempDb}\`\\.`, 'g'),
            `\`${targetDb}\`.`,
          );
          // Drop existing view in target if exists, then create
          await connection.query(`DROP VIEW IF EXISTS \`${targetDb}\`.\`${viewName}\``);
          await connection.query(createViewSql);
          logger.debug(`Recreated view: ${targetDb}.${viewName}`);
        }
      }

      // Handle stored procedures and functions
      const [routines] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT ROUTINE_NAME, ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA = ?',
        [tempDb],
      );

      for (const routine of routines) {
        const routineName = routine['ROUTINE_NAME'] as string;
        const routineType = routine['ROUTINE_TYPE'] as string;
        const showCmd =
          routineType === 'PROCEDURE'
            ? `SHOW CREATE PROCEDURE \`${tempDb}\`.\`${routineName}\``
            : `SHOW CREATE FUNCTION \`${tempDb}\`.\`${routineName}\``;
        const [defs] = await connection.query<mysql.RowDataPacket[]>(showCmd);
        if (defs.length > 0) {
          const key = routineType === 'PROCEDURE' ? 'Create Procedure' : 'Create Function';
          let createSql = defs[0]![key] as string;
          createSql = createSql.replace(new RegExp(`\`${tempDb}\`\\.`, 'g'), `\`${targetDb}\`.`);
          await connection
            .query(`DROP ${routineType} IF EXISTS \`${targetDb}\`.\`${routineName}\``)
            .catch(() => {});
          await connection.query(createSql).catch((err: unknown) => {
            logger.warn(
              `Failed to recreate ${routineType.toLowerCase()} ${routineName}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      }
    } finally {
      await connection.end();
    }
  }
}
