/**
 * Dogfood acceptance test: MongoDB
 *
 * Exercises the CLI binary end-to-end against real MongoDB containers.
 */
import { join } from 'node:path';

import { MongoClient, type Db } from 'mongodb';

import {
  runCli,
  createTempDir,
  readFileContent,
  patchConfigTarget,
  MONGO_SOURCE,
  MONGO_TARGET,
  mongoUri,
  waitForMongo,
  generateFakeUsers,
  seedMongoData,
  cleanupMongo,
  type TempDirHandle,
} from './helpers.js';

function createClient(cfg: typeof MONGO_SOURCE): MongoClient {
  const url = `mongodb://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}`;
  return new MongoClient(url);
}

describe('Dogfood: MongoDB full journey', () => {
  let sourceClient: MongoClient;
  let targetClient: MongoClient;
  let sourceDb: Db;
  let targetDb: Db;
  let tmpDir: TempDirHandle;
  let configPath: string;
  const users = generateFakeUsers(100);

  beforeAll(async () => {
    await Promise.all([waitForMongo(MONGO_SOURCE), waitForMongo(MONGO_TARGET)]);

    sourceClient = createClient(MONGO_SOURCE);
    targetClient = createClient(MONGO_TARGET);
    await sourceClient.connect();
    await targetClient.connect();
    sourceDb = sourceClient.db(MONGO_SOURCE.database);
    targetDb = targetClient.db(MONGO_TARGET.database);

    await cleanupMongo(sourceDb);
    await cleanupMongo(targetDb);
    await seedMongoData(sourceDb, users);

    tmpDir = await createTempDir();
    configPath = join(tmpDir.path, 'shinobidb.yaml');
  }, 60_000);

  afterAll(async () => {
    await cleanupMongo(sourceDb);
    await cleanupMongo(targetDb);
    await sourceClient.close();
    await targetClient.close();
    await tmpDir.cleanup();
  });

  it('1. scan detects PII columns', async () => {
    const result = await runCli(['scan', '--uri', mongoUri(MONGO_SOURCE), '--json']);

    expect(result.exitCode).toBe(0);

    const scanResult = JSON.parse(result.stdout);
    expect(scanResult.tablesScanned).toBeGreaterThanOrEqual(1);

    const detectedColumns = scanResult.detections.map(
      (d: { table: string; column: string }) => `${d.table}.${d.column}`,
    );
    expect(detectedColumns).toContain('users.email');
    expect(detectedColumns).toContain('users.first_name');
    expect(detectedColumns).toContain('users.last_name');
  });

  it('2. config generates valid YAML', async () => {
    const result = await runCli(['config', '--uri', mongoUri(MONGO_SOURCE), '-o', configPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Config written to');

    const yaml = await readFileContent(configPath);
    expect(yaml).toContain('source:');
    expect(yaml).toContain('tables:');

    await patchConfigTarget(configPath, MONGO_TARGET);
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
      MONGO_SOURCE.password,
    ]);

    expect(result.exitCode).toBe(0);
    const preview = JSON.parse(result.stdout);
    expect(preview.tables.length).toBeGreaterThanOrEqual(1);
  });

  it('5. mask executes', async () => {
    // Pre-create target collections (MongoDB requires this for masking)
    await targetDb.createCollection('users');
    await targetDb.createCollection('orders');

    const result = await runCli(['mask', '-c', configPath, '--no-progress'], {
      env: {
        SHINOBIDB_SOURCE_PASSWORD: MONGO_SOURCE.password,
        SHINOBIDB_TARGET_PASSWORD: MONGO_TARGET.password,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Masked \d+ row\(s\) across \d+ table\(s\)/);
  });

  it('6. target data is properly masked', async () => {
    const targetRows = await targetDb.collection('users').find({}).sort({ _id: 1 }).toArray();
    const sourceRows = await sourceDb.collection('users').find({}).sort({ _id: 1 }).toArray();

    expect(targetRows.length).toBe(100);

    let emailMasked = 0;
    let nameMasked = 0;

    for (let i = 0; i < sourceRows.length; i++) {
      const src = sourceRows[i]!;
      const tgt = targetRows[i]!;

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
