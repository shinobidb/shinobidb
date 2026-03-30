/**
 * Dogfood acceptance test: MySQL
 *
 * Exercises the CLI binary end-to-end against real MySQL containers.
 * Steps: seed → scan → config → validate → mask --dry-run → mask → verify
 */
import { join } from 'node:path';

import mysql from 'mysql2/promise';

import {
  runCli,
  createTempDir,
  readFileContent,
  patchConfigTarget,
  MYSQL_SOURCE,
  MYSQL_TARGET,
  mysqlUri,
  waitForMySQL,
  generateFakeUsers,
  seedMySQLData,
  cleanupMySQL,
  type TempDirHandle,
} from './helpers.js';

describe('Dogfood: MySQL full journey', () => {
  let sourcePool: mysql.Pool;
  let targetPool: mysql.Pool;
  let tmpDir: TempDirHandle;
  let configPath: string;
  const users = generateFakeUsers(100);

  beforeAll(async () => {
    await Promise.all([waitForMySQL(MYSQL_SOURCE), waitForMySQL(MYSQL_TARGET)]);

    sourcePool = mysql.createPool(MYSQL_SOURCE);
    targetPool = mysql.createPool(MYSQL_TARGET);

    await cleanupMySQL(sourcePool);
    await cleanupMySQL(targetPool);
    await seedMySQLData(sourcePool, users);

    tmpDir = await createTempDir();
    configPath = join(tmpDir.path, 'shinobidb.yaml');
  }, 60_000);

  afterAll(async () => {
    await cleanupMySQL(sourcePool);
    await cleanupMySQL(targetPool);
    await sourcePool.end();
    await targetPool.end();
    await tmpDir.cleanup();
  });

  it('1. scan detects PII columns via --uri', async () => {
    const result = await runCli([
      'scan',
      '--uri',
      mysqlUri(MYSQL_SOURCE),
      '--schemas',
      'source_db',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);

    const scanResult = JSON.parse(result.stdout);
    expect(scanResult.tablesScanned).toBeGreaterThanOrEqual(3);

    const detectedColumns = scanResult.detections.map(
      (d: { table: string; column: string }) => `${d.table}.${d.column}`,
    );
    expect(detectedColumns).toContain('users.email');
    expect(detectedColumns).toContain('users.first_name');
    expect(detectedColumns).toContain('users.last_name');
    expect(detectedColumns).toContain('users.phone');
    expect(detectedColumns).toContain('users.ip_address');
  });

  it('2. config generates valid YAML via --uri', async () => {
    const result = await runCli([
      'config',
      '--uri',
      mysqlUri(MYSQL_SOURCE),
      '--schemas',
      'source_db',
      '-o',
      configPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Config written to');

    const yaml = await readFileContent(configPath);
    expect(yaml).toContain('source:');
    expect(yaml).toContain('tables:');
    expect(yaml).toContain('email');
    expect(yaml).toContain('first_name');

    // Patch target connection info (config generates placeholders)
    await patchConfigTarget(configPath, MYSQL_TARGET);
  });

  it('3. validate passes on generated config', async () => {
    const result = await runCli(['validate', '-c', configPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Config is valid');
  });

  it('4. mask --dry-run shows preview without writing', async () => {
    const result = await runCli([
      'mask',
      '-c',
      configPath,
      '--dry-run',
      '--json',
      '--source-password',
      MYSQL_SOURCE.password,
    ]);

    expect(result.exitCode).toBe(0);

    const preview = JSON.parse(result.stdout);
    expect(preview.tables.length).toBeGreaterThanOrEqual(1);
    expect(preview.totalRows).toBeGreaterThan(0);

    // Verify dry-run doesn't write to target
    const [rows] = await targetPool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = 'target_db' AND table_name = 'users'",
    );
    expect(rows[0]!.cnt).toBe(0);
  });

  it('5. mask executes and copies data to target', async () => {
    const result = await runCli([
      'mask',
      '-c',
      configPath,
      '--source-password',
      MYSQL_SOURCE.password,
      '--target-password',
      MYSQL_TARGET.password,
      '--sync-schema',
      '--no-progress',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Masked \d+ row\(s\) across \d+ table\(s\)/);
  });

  it('6. target data is properly masked', async () => {
    const [targetRows] = await targetPool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM users ORDER BY id',
    );

    expect(targetRows.length).toBe(100);

    // Compare against source data
    const [sourceRows] = await sourcePool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM users ORDER BY id',
    );

    let emailMasked = 0;
    let nameMasked = 0;
    let phoneMasked = 0;
    let ipMasked = 0;

    for (let i = 0; i < sourceRows.length; i++) {
      const src = sourceRows[i]!;
      const tgt = targetRows[i]!;

      // IDs should be preserved
      expect(tgt.id).toBe(src.id);

      // Email: should be different but retain domain structure (has @)
      if (tgt.email !== src.email) {
        emailMasked++;
        expect(tgt.email).toContain('@');
      }

      // Names: should be different
      if (tgt.first_name !== src.first_name) nameMasked++;

      // Phone: should be different
      if (tgt.phone !== src.phone) phoneMasked++;

      // IP: should be different but remain valid IP format
      if (tgt.ip_address !== src.ip_address) {
        ipMasked++;
        expect(tgt.ip_address).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      }

      // created_at should be preserved
      expect(new Date(tgt.created_at).getTime()).toBe(new Date(src.created_at).getTime());
    }

    // At least 90% of rows should have masked PII fields
    expect(emailMasked).toBeGreaterThan(90);
    expect(nameMasked).toBeGreaterThan(90);
    expect(phoneMasked).toBeGreaterThan(90);
    expect(ipMasked).toBeGreaterThan(90);
  });

  it('7. scan with -c reads connection from config file', async () => {
    const result = await runCli(['scan', '-c', configPath, '--json'], {
      env: {
        SHINOBIDB_SOURCE_PASSWORD: MYSQL_SOURCE.password,
      },
    });

    expect(result.exitCode).toBe(0);

    const scanResult = JSON.parse(result.stdout);
    expect(scanResult.tablesScanned).toBeGreaterThanOrEqual(1);
  });

  it('8. mask with env var password works', async () => {
    // Re-seed source, clean target
    await cleanupMySQL(targetPool);
    await cleanupMySQL(sourcePool);
    await seedMySQLData(sourcePool, users);

    const result = await runCli(['mask', '-c', configPath, '--sync-schema', '--no-progress'], {
      env: {
        SHINOBIDB_SOURCE_PASSWORD: MYSQL_SOURCE.password,
        SHINOBIDB_TARGET_PASSWORD: MYSQL_TARGET.password,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Masked \d+ row\(s\)/);

    const [rows] = await targetPool.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) as cnt FROM users',
    );
    expect(rows[0]!.cnt).toBe(100);
  });
});
