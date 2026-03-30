#!/usr/bin/env node
/**
 * Large-scale benchmark for shinobidb.
 *
 * Prerequisites:
 *   docker compose up -d mysql-source mysql-target
 *   npm run build
 *
 * Usage:
 *   node scripts/benchmark.mjs
 *
 * What it does:
 *   1. Creates 50 tables in source MySQL (1 table with 1M rows, 49 tables with ~2K rows each)
 *   2. Runs: shinobidb scan → config → mask --sync-schema --dry-run → mask --sync-schema
 *   3. Reports wall-clock time and peak RSS for each step
 */

import { createConnection, createPool } from 'mysql2/promise';
import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── Config ───

const SOURCE = { host: '127.0.0.1', port: 3307, user: 'root', password: 'rootpass', database: 'source_db' };
const TARGET = { host: '127.0.0.1', port: 3308, user: 'root', password: 'rootpass', database: 'target_db' };
const CLI_PATH = resolve(process.cwd(), 'dist/cli.js');
const LARGE_TABLE_ROWS = 1_000_000;
const SMALL_TABLE_COUNT = 49;
const SMALL_TABLE_ROWS = 2_000;
const BATCH_INSERT_SIZE = 10_000;

// ─── Helpers ───

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatMemory(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function runCli(args, { timeout = 600_000 } = {}) {
  const start = Date.now();
  try {
    const result = await execFileAsync('node', [CLI_PATH, ...args], {
      env: { ...process.env, NO_COLOR: '1' },
      timeout,
      maxBuffer: 50 * 1024 * 1024,
    });
    const elapsed = Date.now() - start;
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, elapsed };
  } catch (err) {
    const elapsed = Date.now() - start;
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.code ?? 1, elapsed };
  }
}

/** Run CLI via /usr/bin/time to capture peak RSS (macOS) */
async function runCliWithMemory(args, { timeout = 600_000 } = {}) {
  const start = Date.now();
  try {
    const result = await execFileAsync('/usr/bin/time', ['-l', 'node', CLI_PATH, ...args], {
      env: { ...process.env, NO_COLOR: '1' },
      timeout,
      maxBuffer: 50 * 1024 * 1024,
    });
    const elapsed = Date.now() - start;
    const peakRss = parsePeakRss(result.stderr);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, elapsed, peakRss };
  } catch (err) {
    const elapsed = Date.now() - start;
    const peakRss = parsePeakRss(err.stderr ?? '');
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.code ?? 1, elapsed, peakRss };
  }
}

function parsePeakRss(stderr) {
  // macOS: "  12345678  maximum resident set size" (bytes)
  const match = stderr.match(/(\d+)\s+maximum resident set size/);
  return match ? parseInt(match[1], 10) : null;
}

// ─── Seed ───

async function waitForMySQL(config, maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const conn = await createConnection(config);
      await conn.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`MySQL not ready after ${maxRetries}s`);
}

async function seedLargeTable(pool, tableName, rowCount) {
  await pool.query(`DROP TABLE IF EXISTS \`${tableName}\``);
  await pool.query(`
    CREATE TABLE \`${tableName}\` (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      phone VARCHAR(50),
      ip_address VARCHAR(45),
      notes TEXT,
      amount DECIMAL(10,2),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  let inserted = 0;
  while (inserted < rowCount) {
    const batchSize = Math.min(BATCH_INSERT_SIZE, rowCount - inserted);
    const values = [];
    for (let i = 0; i < batchSize; i++) {
      const n = inserted + i;
      values.push([
        `user${n}@company${n % 100}.com`,
        `First${n}`,
        `Last${n}`,
        `+1-555-${String(n % 10000).padStart(4, '0')}`,
        `${(n >> 24) & 255}.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`,
        `Notes for user ${n}. Contact user${n}@company${n % 100}.com`,
        (n * 1.23).toFixed(2),
      ]);
    }
    await pool.query(
      `INSERT INTO \`${tableName}\` (email, first_name, last_name, phone, ip_address, notes, amount) VALUES ?`,
      [values],
    );
    inserted += batchSize;
    if (inserted % 100_000 === 0 || inserted === rowCount) {
      process.stdout.write(`\r  ${tableName}: ${inserted.toLocaleString()} / ${rowCount.toLocaleString()} rows`);
    }
  }
  console.log();
}

async function seedSmallTable(pool, tableName, rowCount) {
  await pool.query(`DROP TABLE IF EXISTS \`${tableName}\``);
  await pool.query(`
    CREATE TABLE \`${tableName}\` (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255),
      name VARCHAR(200),
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const values = [];
  for (let i = 0; i < rowCount; i++) {
    values.push([`user${i}@example.com`, `User ${i}`, 'active']);
  }
  await pool.query(
    `INSERT INTO \`${tableName}\` (email, name, status) VALUES ?`,
    [values],
  );
}

async function cleanupTarget(pool) {
  const [rows] = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'",
    [TARGET.database],
  );
  for (const row of rows) {
    await pool.query(`DROP TABLE IF EXISTS \`${row.TABLE_NAME ?? row.table_name}\``);
  }
}

// ─── Main ───

async function main() {
  console.log('=== shinobidb Large-Scale Benchmark ===\n');

  // Wait for MySQL
  console.log('Waiting for MySQL...');
  await waitForMySQL(SOURCE);
  await waitForMySQL(TARGET);
  console.log('MySQL ready.\n');

  const sourcePool = createPool({ ...SOURCE, connectionLimit: 5 });
  const targetPool = createPool({ ...TARGET, connectionLimit: 5 });

  // Seed data
  console.log(`Seeding: 1 table × ${LARGE_TABLE_ROWS.toLocaleString()} rows + ${SMALL_TABLE_COUNT} tables × ${SMALL_TABLE_ROWS.toLocaleString()} rows`);
  console.log(`Total: ~${(LARGE_TABLE_ROWS + SMALL_TABLE_COUNT * SMALL_TABLE_ROWS).toLocaleString()} rows across ${1 + SMALL_TABLE_COUNT} tables\n`);

  const seedStart = Date.now();

  await seedLargeTable(sourcePool, 'users_large', LARGE_TABLE_ROWS);

  for (let i = 1; i <= SMALL_TABLE_COUNT; i++) {
    await seedSmallTable(sourcePool, `table_${String(i).padStart(3, '0')}`, SMALL_TABLE_ROWS);
    if (i % 10 === 0) console.log(`  Small tables: ${i} / ${SMALL_TABLE_COUNT}`);
  }

  const seedDuration = Date.now() - seedStart;
  console.log(`\nSeed completed in ${formatDuration(seedDuration)}\n`);

  // Clean target
  await cleanupTarget(targetPool);

  // Create temp dir for config
  const tmpDir = join(tmpdir(), `shinobidb-bench-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  const configPath = join(tmpDir, 'shinobidb.yaml');

  const results = [];

  // Step 1: scan
  console.log('--- Step 1: scan ---');
  const scanResult = await runCliWithMemory([
    'scan',
    '--host', SOURCE.host,
    '--port', String(SOURCE.port),
    '--user', SOURCE.user,
    '--password', SOURCE.password,
    '--schemas', SOURCE.database,
  ]);
  console.log(`  Time: ${formatDuration(scanResult.elapsed)}`);
  console.log(`  Peak RSS: ${scanResult.peakRss ? formatMemory(scanResult.peakRss) : 'N/A'}`);
  console.log(`  Exit code: ${scanResult.exitCode}`);
  results.push({ step: 'scan', ...pick(scanResult) });

  // Step 2: config
  console.log('\n--- Step 2: config ---');
  const configResult = await runCliWithMemory([
    'config',
    '--host', SOURCE.host,
    '--port', String(SOURCE.port),
    '--user', SOURCE.user,
    '--password', SOURCE.password,
    '--schemas', SOURCE.database,
    '--include-all-tables',
    '-o', configPath,
  ]);
  console.log(`  Time: ${formatDuration(configResult.elapsed)}`);
  console.log(`  Peak RSS: ${configResult.peakRss ? formatMemory(configResult.peakRss) : 'N/A'}`);
  console.log(`  Exit code: ${configResult.exitCode}`);
  results.push({ step: 'config', ...pick(configResult) });

  // Patch config with real target
  const YAML = await import('yaml');
  const { readFile } = await import('node:fs/promises');
  const configContent = await readFile(configPath, 'utf-8');
  const config = YAML.parse(configContent);
  config.target = {
    type: 'mysql',
    host: TARGET.host,
    port: TARGET.port,
    user: TARGET.user,
    password: TARGET.password,
    database: TARGET.database,
  };
  await writeFile(configPath, YAML.stringify(config), 'utf-8');

  // Step 3: mask --dry-run
  console.log('\n--- Step 3: mask --dry-run ---');
  const dryRunResult = await runCliWithMemory([
    'mask',
    '-c', configPath,
    '--source-password', SOURCE.password,
    '--target-password', TARGET.password,
    '--dry-run',
    '--no-progress',
  ], { timeout: 600_000 });
  console.log(`  Time: ${formatDuration(dryRunResult.elapsed)}`);
  console.log(`  Peak RSS: ${dryRunResult.peakRss ? formatMemory(dryRunResult.peakRss) : 'N/A'}`);
  console.log(`  Exit code: ${dryRunResult.exitCode}`);
  results.push({ step: 'mask --dry-run', ...pick(dryRunResult) });

  // Step 4: mask (actual)
  console.log('\n--- Step 4: mask --sync-schema ---');
  const maskResult = await runCliWithMemory([
    'mask',
    '-c', configPath,
    '--source-password', SOURCE.password,
    '--target-password', TARGET.password,
    '--sync-schema',
    '--no-progress',
    '--concurrency', '4',
  ], { timeout: 600_000 });
  console.log(`  Time: ${formatDuration(maskResult.elapsed)}`);
  console.log(`  Peak RSS: ${maskResult.peakRss ? formatMemory(maskResult.peakRss) : 'N/A'}`);
  console.log(`  Exit code: ${maskResult.exitCode}`);
  results.push({ step: 'mask --sync-schema', ...pick(maskResult) });

  if (maskResult.exitCode !== 0) {
    console.log('\n  stderr (last 500 chars):');
    console.log('  ' + maskResult.stderr.slice(-500).replace(/\n/g, '\n  '));
  }

  // Verify target row count
  console.log('\n--- Verification ---');
  const [targetRows] = await targetPool.query(
    `SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_rows DESC`,
    [TARGET.database],
  );
  let totalTargetRows = 0;
  let tableCount = 0;
  for (const row of targetRows) {
    totalTargetRows += Number(row.TABLE_ROWS ?? row.table_rows ?? 0);
    tableCount++;
  }
  console.log(`  Target tables: ${tableCount}`);
  console.log(`  Target total rows (estimated): ${totalTargetRows.toLocaleString()}`);

  // Summary
  console.log('\n=== Summary ===\n');
  console.log('Step                  | Time      | Peak RSS  | Exit');
  console.log('─────────────────────-|───────────|───────────|──────');
  for (const r of results) {
    console.log(
      `${r.step.padEnd(22)}| ${formatDuration(r.elapsed).padEnd(10)}| ${(r.peakRss ? formatMemory(r.peakRss) : 'N/A').padEnd(10)}| ${r.exitCode}`,
    );
  }

  // Cleanup
  await rm(tmpDir, { recursive: true, force: true });
  await sourcePool.end();
  await targetPool.end();

  const failed = results.some((r) => r.exitCode !== 0);
  if (failed) {
    console.log('\n!! Some steps failed. Review stderr output above.');
    process.exit(1);
  }

  // Memory threshold check
  const maxRss = Math.max(...results.map((r) => r.peakRss ?? 0));
  if (maxRss > 512 * 1024 * 1024) {
    console.log(`\n!! Peak memory (${formatMemory(maxRss)}) exceeds 512MB threshold.`);
    process.exit(1);
  }

  console.log('\nAll steps passed. Memory within bounds.');
}

function pick(result) {
  return { elapsed: result.elapsed, peakRss: result.peakRss, exitCode: result.exitCode };
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
