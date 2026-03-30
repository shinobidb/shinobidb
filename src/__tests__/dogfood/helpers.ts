import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { faker } from '@faker-js/faker';
import { execa } from 'execa';
import { MongoClient, type Db } from 'mongodb';
import mysql from 'mysql2/promise';
import pg from 'pg';
import YAML from 'yaml';

// ─── CLI runner ───

// Use process.cwd() since tests are always run from the project root
const CLI_PATH = resolve(process.cwd(), 'dist/cli.js');

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCli(
  args: string[],
  options?: { env?: Record<string, string>; timeout?: number },
): Promise<CliResult> {
  try {
    const result = await execa('node', [CLI_PATH, ...args], {
      env: { ...process.env, ...options?.env, NO_COLOR: '1' },
      timeout: options?.timeout ?? 60_000,
      reject: false,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1,
    };
  } catch (err: unknown) {
    // execa with reject:false should not throw, but handle edge cases
    const e = err as { stdout?: string; stderr?: string; exitCode?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.exitCode ?? 1,
    };
  }
}

// ─── Temp dir ───

export interface TempDirHandle {
  path: string;
  cleanup: () => Promise<void>;
}

export async function createTempDir(): Promise<TempDirHandle> {
  const path = await mkdtemp(join(tmpdir(), 'shinobidb-dogfood-'));
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

export async function readFileContent(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8');
}

/**
 * Patch the generated config YAML to set real target connection info and source password placeholder.
 * The `config` command generates placeholders for target and source password.
 */
export async function patchConfigTarget(
  configFilePath: string,
  target: { host: string; port: number; user: string; password: string; database: string },
): Promise<void> {
  const content = await readFile(configFilePath, 'utf-8');
  const config = YAML.parse(content) as Record<string, unknown>;
  const tgt = config.target as Record<string, unknown>;
  tgt.host = target.host;
  tgt.port = target.port;
  tgt.user = target.user;
  tgt.password = target.password;
  tgt.database = target.database;
  await writeFile(configFilePath, YAML.stringify(config), 'utf-8');
}

// ─── MySQL ───

export const MYSQL_SOURCE = {
  host: '127.0.0.1',
  port: 3307,
  user: 'root',
  password: 'rootpass',
  database: 'source_db',
};

export const MYSQL_TARGET = {
  host: '127.0.0.1',
  port: 3308,
  user: 'root',
  password: 'rootpass',
  database: 'target_db',
};

export function mysqlUri(cfg: typeof MYSQL_SOURCE): string {
  return `mysql://${cfg.user}:${cfg.password}@${cfg.host}:${cfg.port}/${cfg.database}`;
}

export async function waitForMySQL(config: typeof MYSQL_SOURCE, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const conn = await mysql.createConnection(config);
      await conn.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`MySQL at ${config.host}:${config.port} not ready after ${maxRetries}s`);
}

// ─── PostgreSQL ───

export const PG_SOURCE = {
  host: '127.0.0.1',
  port: 5433,
  user: 'postgres',
  password: 'rootpass',
  database: 'source_db',
};

export const PG_TARGET = {
  host: '127.0.0.1',
  port: 5434,
  user: 'postgres',
  password: 'rootpass',
  database: 'target_db',
};

export function pgUri(cfg: typeof PG_SOURCE): string {
  return `postgresql://${cfg.user}:${cfg.password}@${cfg.host}:${cfg.port}/${cfg.database}`;
}

export async function waitForPostgres(config: typeof PG_SOURCE, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = new pg.Client(config);
      await client.connect();
      await client.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`PostgreSQL at ${config.host}:${config.port} not ready after ${maxRetries}s`);
}

// ─── MongoDB ───

export const MONGO_SOURCE = {
  host: '127.0.0.1',
  port: 27020,
  user: 'admin',
  password: 'rootpass',
  database: 'source_db',
};

export const MONGO_TARGET = {
  host: '127.0.0.1',
  port: 27021,
  user: 'admin',
  password: 'rootpass',
  database: 'target_db',
};

export function mongoUri(cfg: typeof MONGO_SOURCE): string {
  return `mongodb://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}/${cfg.database}`;
}

export async function waitForMongo(config: typeof MONGO_SOURCE, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const url = `mongodb://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}`;
      const client = new MongoClient(url);
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      await client.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`MongoDB at ${config.host}:${config.port} not ready after ${maxRetries}s`);
}

// ─── Seed data with faker ───

interface FakeUser {
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  ip_address: string;
  notes: string;
}

export function generateFakeUsers(count: number): FakeUser[] {
  faker.seed(42);
  const users: FakeUser[] = [];
  for (let i = 0; i < count; i++) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const email = faker.internet.email({ firstName, lastName });
    users.push({
      email,
      first_name: firstName,
      last_name: lastName,
      phone: faker.phone.number({ style: 'international' }),
      ip_address: faker.internet.ipv4(),
      notes: `Contact ${email} for details. Phone: ${faker.phone.number({ style: 'international' })}`,
    });
  }
  return users;
}

// ─── MySQL seed/cleanup ───

export async function seedMySQLData(pool: mysql.Pool, users: FakeUser[]): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS orders');
  await pool.query('DROP TABLE IF EXISTS logs');
  await pool.query('DROP TABLE IF EXISTS users');

  await pool.query(`
    CREATE TABLE users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      phone VARCHAR(50),
      ip_address VARCHAR(45),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      shipping_address TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      level VARCHAR(10) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Insert users
  if (users.length > 0) {
    const values = users.map((u) => [
      u.email,
      u.first_name,
      u.last_name,
      u.phone,
      u.ip_address,
      u.notes,
    ]);
    await pool.query(
      'INSERT INTO users (email, first_name, last_name, phone, ip_address, notes) VALUES ?',
      [values],
    );
  }

  // Insert orders referencing users
  const orderValues = users
    .slice(0, Math.min(20, users.length))
    .map((_, i) => [
      i + 1,
      faker.commerce.price({ min: 10, max: 500 }),
      faker.location.streetAddress({ useFullAddress: true }),
    ]);
  if (orderValues.length > 0) {
    await pool.query('INSERT INTO orders (user_id, amount, shipping_address) VALUES ?', [
      orderValues,
    ]);
  }

  // Insert logs (no PII - should be detected as non-PII)
  const logValues = Array.from({ length: 10 }, () => [
    faker.helpers.arrayElement(['INFO', 'WARN', 'ERROR']),
    faker.lorem.sentence(),
  ]);
  await pool.query('INSERT INTO logs (level, message) VALUES ?', [logValues]);
}

export async function cleanupMySQL(pool: mysql.Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS orders');
  await pool.query('DROP TABLE IF EXISTS logs');
  await pool.query('DROP TABLE IF EXISTS users');
}

// ─── PostgreSQL seed/cleanup ───

export async function seedPgData(pool: pg.Pool, users: FakeUser[]): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS orders');
  await pool.query('DROP TABLE IF EXISTS logs');
  await pool.query('DROP TABLE IF EXISTS users');

  await pool.query(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      phone VARCHAR(50),
      ip_address VARCHAR(45),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE orders (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      shipping_address TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE logs (
      id SERIAL PRIMARY KEY,
      level VARCHAR(10) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const u of users) {
    await pool.query(
      'INSERT INTO users (email, first_name, last_name, phone, ip_address, notes) VALUES ($1, $2, $3, $4, $5, $6)',
      [u.email, u.first_name, u.last_name, u.phone, u.ip_address, u.notes],
    );
  }

  for (let i = 0; i < Math.min(20, users.length); i++) {
    await pool.query('INSERT INTO orders (user_id, amount, shipping_address) VALUES ($1, $2, $3)', [
      i + 1,
      faker.commerce.price({ min: 10, max: 500 }),
      faker.location.streetAddress({ useFullAddress: true }),
    ]);
  }

  for (let i = 0; i < 10; i++) {
    await pool.query('INSERT INTO logs (level, message) VALUES ($1, $2)', [
      faker.helpers.arrayElement(['INFO', 'WARN', 'ERROR']),
      faker.lorem.sentence(),
    ]);
  }

  await pool.query('ANALYZE users');
  await pool.query('ANALYZE orders');
  await pool.query('ANALYZE logs');
}

export async function cleanupPg(pool: pg.Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS orders');
  await pool.query('DROP TABLE IF EXISTS logs');
  await pool.query('DROP TABLE IF EXISTS users');
}

// ─── MongoDB seed/cleanup ───

export async function seedMongoData(db: Db, users: FakeUser[]): Promise<void> {
  const collections = await db.listCollections().toArray();
  for (const col of collections) {
    await db.dropCollection(col.name);
  }

  const usersCol = db.collection('users');
  if (users.length > 0) {
    await usersCol.insertMany(
      users.map((u) => ({
        ...u,
        created_at: faker.date.past(),
      })),
    );
  }

  const ordersCol = db.collection('orders');
  await ordersCol.insertMany(
    users.slice(0, Math.min(20, users.length)).map((_, i) => ({
      user_id: i + 1,
      amount: parseFloat(faker.commerce.price({ min: 10, max: 500 })),
      shipping_address: faker.location.streetAddress({ useFullAddress: true }),
      created_at: faker.date.past(),
    })),
  );
}

export async function cleanupMongo(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  for (const col of collections) {
    await db.dropCollection(col.name);
  }
}
