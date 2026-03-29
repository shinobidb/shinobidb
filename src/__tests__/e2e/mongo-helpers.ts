import { MongoClient, type Db } from 'mongodb';

export const MONGO_SOURCE_CONFIG = {
  host: '127.0.0.1',
  port: 27020,
  user: 'admin',
  password: 'rootpass',
  database: 'source_db',
};

export const MONGO_TARGET_CONFIG = {
  host: '127.0.0.1',
  port: 27021,
  user: 'admin',
  password: 'rootpass',
  database: 'target_db',
};

function buildUrl(config: { host: string; port: number; user: string; password: string }): string {
  return `mongodb://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}`;
}

export async function waitForMongo(
  config: { host: string; port: number; user: string; password: string },
  maxRetries = 30,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = new MongoClient(buildUrl(config));
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      await client.close();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`MongoDB at ${config.host}:${config.port} not ready after ${maxRetries}s`);
}

export function createMongoClient(config: {
  host: string;
  port: number;
  user: string;
  password: string;
}): MongoClient {
  return new MongoClient(buildUrl(config));
}

export async function setupMongoSourceData(db: Db): Promise<void> {
  const users = db.collection('users');
  await users.insertMany([
    {
      email: 'alice@example.com',
      first_name: 'Alice',
      last_name: 'Johnson',
      phone: '+1-555-123-4567',
      ip_address: '192.168.1.10',
      notes: 'Customer since 2020. Contact: alice@example.com',
      created_at: new Date('2024-01-15T10:30:00Z'),
    },
    {
      email: 'bob@company.org',
      first_name: 'Bob',
      last_name: 'Smith',
      phone: '+1-555-987-6543',
      ip_address: '10.0.0.5',
      notes: 'VIP customer. Call +1-555-987-6543 for support',
      created_at: new Date('2024-02-20T14:00:00Z'),
    },
    {
      email: 'charlie@test.io',
      first_name: 'Charlie',
      last_name: 'Brown',
      phone: '+1-555-456-7890',
      ip_address: '172.16.0.1',
      notes: 'Regular user, no special notes',
      created_at: new Date('2024-03-10T08:15:00Z'),
    },
  ]);
}

export async function setupMongoTargetCollection(db: Db): Promise<void> {
  // In MongoDB, collections are created implicitly on insert.
  // Create an empty collection explicitly for the target.
  await db.createCollection('users');
}

export async function cleanupMongoDatabase(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  for (const col of collections) {
    await db.dropCollection(col.name);
  }
}

export async function getMongoRows(db: Db, collection: string): Promise<Record<string, unknown>[]> {
  return (await db.collection(collection).find({}).toArray()) as Record<string, unknown>[];
}
