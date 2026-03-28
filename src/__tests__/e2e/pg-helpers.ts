import pg from 'pg';

export const PG_SOURCE_CONFIG = {
  host: '127.0.0.1',
  port: 5433,
  user: 'postgres',
  password: 'rootpass',
  database: 'source_db',
};

export const PG_TARGET_CONFIG = {
  host: '127.0.0.1',
  port: 5434,
  user: 'postgres',
  password: 'rootpass',
  database: 'target_db',
};

export async function waitForPostgres(
  config: { host: string; port: number; user: string; password: string; database: string },
  maxRetries = 30,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = new pg.Client(config);
      await client.connect();
      await client.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`PostgreSQL at ${config.host}:${config.port} not ready after ${maxRetries}s`);
}

export async function setupPgSourceData(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
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
    INSERT INTO users (email, first_name, last_name, phone, ip_address, notes) VALUES
    ('alice@example.com', 'Alice', 'Johnson', '+1-555-123-4567', '192.168.1.10', 'Customer since 2020. Contact: alice@example.com'),
    ('bob@company.org', 'Bob', 'Smith', '+1-555-987-6543', '10.0.0.5', 'VIP customer. Call +1-555-987-6543 for support'),
    ('charlie@test.io', 'Charlie', 'Brown', '+1-555-456-7890', '172.16.0.1', 'Regular user, no special notes')
  `);

  // Force pg_class stats update for getRowCount
  await pool.query('ANALYZE users');
}

export async function setupPgTargetSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
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
}

export async function cleanupPgDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS users');
}

export async function getPgRows(pool: pg.Pool, table: string): Promise<Record<string, unknown>[]> {
  const result = await pool.query(`SELECT * FROM ${table}`);
  return result.rows as Record<string, unknown>[];
}
