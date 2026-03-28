import mysql from 'mysql2/promise';

export const SOURCE_CONFIG = {
  host: '127.0.0.1',
  port: 3307,
  user: 'root',
  password: 'rootpass',
  database: 'source_db',
};

export const TARGET_CONFIG = {
  host: '127.0.0.1',
  port: 3308,
  user: 'root',
  password: 'rootpass',
  database: 'target_db',
};

export async function waitForMySQL(
  config: { host: string; port: number; user: string; password: string },
  maxRetries = 30,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const conn = await mysql.createConnection(config);
      await conn.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`MySQL at ${config.host}:${config.port} not ready after ${maxRetries}s`);
}

export async function setupSourceData(pool: mysql.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
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
    INSERT INTO users (email, first_name, last_name, phone, ip_address, notes) VALUES
    ('alice@example.com', 'Alice', 'Johnson', '+1-555-123-4567', '192.168.1.10', 'Customer since 2020. Contact: alice@example.com'),
    ('bob@company.org', 'Bob', 'Smith', '+1-555-987-6543', '10.0.0.5', 'VIP customer. Call +1-555-987-6543 for support'),
    ('charlie@test.io', 'Charlie', 'Brown', '+1-555-456-7890', '172.16.0.1', 'Regular user, no special notes')
  `);
}

export async function setupTargetSchema(pool: mysql.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
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
}

export async function cleanupDatabase(pool: mysql.Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS users');
}

export async function getRows(pool: mysql.Pool, table: string): Promise<mysql.RowDataPacket[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT * FROM ${table}`);
  return rows;
}
