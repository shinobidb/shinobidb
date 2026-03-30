/**
 * Dogfood acceptance test: PostgreSQL
 *
 * Exercises the CLI binary end-to-end against real PostgreSQL containers.
 */
import { join } from 'node:path';

import pg from 'pg';

import {
  runCli,
  createTempDir,
  readFileContent,
  patchConfigTarget,
  PG_SOURCE,
  PG_TARGET,
  pgUri,
  waitForPostgres,
  generateFakeUsers,
  seedPgData,
  cleanupPg,
  type TempDirHandle,
} from './helpers.js';

describe('Dogfood: PostgreSQL full journey', () => {
  let sourcePool: pg.Pool;
  let targetPool: pg.Pool;
  let tmpDir: TempDirHandle;
  let configPath: string;
  const users = generateFakeUsers(100);

  beforeAll(async () => {
    await Promise.all([waitForPostgres(PG_SOURCE), waitForPostgres(PG_TARGET)]);

    sourcePool = new pg.Pool(PG_SOURCE);
    targetPool = new pg.Pool(PG_TARGET);

    await cleanupPg(sourcePool);
    await cleanupPg(targetPool);
    await seedPgData(sourcePool, users);

    tmpDir = await createTempDir();
    configPath = join(tmpDir.path, 'shinobidb.yaml');
  }, 60_000);

  afterAll(async () => {
    await cleanupPg(sourcePool);
    await cleanupPg(targetPool);
    await sourcePool.end();
    await targetPool.end();
    await tmpDir.cleanup();
  });

  it('1. scan detects PII columns', async () => {
    const result = await runCli([
      'scan',
      '--uri',
      pgUri(PG_SOURCE),
      '--schemas',
      'public',
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
  });

  it('2. config generates valid YAML', async () => {
    const result = await runCli([
      'config',
      '--uri',
      pgUri(PG_SOURCE),
      '--schemas',
      'public',
      '-o',
      configPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Config written to');

    const yaml = await readFileContent(configPath);
    expect(yaml).toContain('source:');
    expect(yaml).toContain('tables:');

    await patchConfigTarget(configPath, PG_TARGET);
  });

  it('3. validate passes', async () => {
    const result = await runCli(['validate', '-c', configPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Config is valid');
  });

  it('4. mask --dry-run shows preview', async () => {
    const result = await runCli([
      'mask',
      '-c',
      configPath,
      '--dry-run',
      '--json',
      '--source-password',
      PG_SOURCE.password,
    ]);

    expect(result.exitCode).toBe(0);
    const preview = JSON.parse(result.stdout);
    expect(preview.tables.length).toBeGreaterThanOrEqual(1);
    expect(preview.totalRows).toBeGreaterThan(0);
  });

  it('5. mask executes', async () => {
    const result = await runCli(['mask', '-c', configPath, '--sync-schema', '--no-progress'], {
      env: {
        SHINOBIDB_SOURCE_PASSWORD: PG_SOURCE.password,
        SHINOBIDB_TARGET_PASSWORD: PG_TARGET.password,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Masked \d+ row\(s\) across \d+ table\(s\)/);
  });

  it('6. target data is properly masked', async () => {
    const targetResult = await targetPool.query('SELECT * FROM users ORDER BY id');
    const sourceResult = await sourcePool.query('SELECT * FROM users ORDER BY id');

    expect(targetResult.rows.length).toBe(100);

    let emailMasked = 0;
    let nameMasked = 0;

    for (let i = 0; i < sourceResult.rows.length; i++) {
      const src = sourceResult.rows[i] as Record<string, unknown>;
      const tgt = targetResult.rows[i] as Record<string, unknown>;

      expect(tgt.id).toBe(src.id);

      if (tgt.email !== src.email) {
        emailMasked++;
        expect(tgt.email as string).toContain('@');
      }
      if (tgt.first_name !== src.first_name) nameMasked++;
    }

    expect(emailMasked).toBeGreaterThan(90);
    expect(nameMasked).toBeGreaterThan(90);
  });
});
