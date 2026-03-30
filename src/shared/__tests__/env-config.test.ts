import { readEnvConnection } from '../env-config.js';
import { ConfigValidationError } from '../errors.js';

describe('readEnvConnection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return empty object when no env vars are set', () => {
    delete process.env.SHINOBIDB_SOURCE_HOST;
    delete process.env.SHINOBIDB_SOURCE_PORT;
    delete process.env.SHINOBIDB_SOURCE_USER;
    delete process.env.SHINOBIDB_SOURCE_PASSWORD;
    delete process.env.SHINOBIDB_SOURCE_DATABASE;
    delete process.env.SHINOBIDB_SOURCE_TYPE;
    delete process.env.SHINOBIDB_SOURCE_URI;

    const result = readEnvConnection('source');
    expect(result).toEqual({});
  });

  it('should read individual source env vars', () => {
    process.env.SHINOBIDB_SOURCE_HOST = 'db.example.com';
    process.env.SHINOBIDB_SOURCE_PORT = '5432';
    process.env.SHINOBIDB_SOURCE_USER = 'admin';
    process.env.SHINOBIDB_SOURCE_PASSWORD = 'secret';
    process.env.SHINOBIDB_SOURCE_DATABASE = 'mydb';
    process.env.SHINOBIDB_SOURCE_TYPE = 'postgres';

    const result = readEnvConnection('source');
    expect(result).toEqual({
      host: 'db.example.com',
      port: 5432,
      user: 'admin',
      password: 'secret',
      database: 'mydb',
      type: 'postgres',
    });
  });

  it('should read target env vars', () => {
    process.env.SHINOBIDB_TARGET_HOST = 'staging.example.com';
    process.env.SHINOBIDB_TARGET_PORT = '3306';
    process.env.SHINOBIDB_TARGET_USER = 'root';
    process.env.SHINOBIDB_TARGET_PASSWORD = 'pass';
    process.env.SHINOBIDB_TARGET_TYPE = 'mysql';

    const result = readEnvConnection('target');
    expect(result).toEqual({
      host: 'staging.example.com',
      port: 3306,
      user: 'root',
      password: 'pass',
      type: 'mysql',
    });
  });

  it('should parse URI env var', () => {
    process.env.SHINOBIDB_SOURCE_URI = 'mysql://root:pass@localhost:3306/mydb';

    const result = readEnvConnection('source');
    expect(result).toEqual({
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: 'pass',
      database: 'mydb',
    });
  });

  it('should allow PASSWORD env var to override URI password (when URI has no password)', () => {
    process.env.SHINOBIDB_SOURCE_URI = 'mysql://root@localhost:3306/mydb';
    process.env.SHINOBIDB_SOURCE_PASSWORD = 'from-env';

    const result = readEnvConnection('source');
    expect(result.password).toBe('from-env');
  });

  it('should throw when URI and individual fields are both set', () => {
    process.env.SHINOBIDB_SOURCE_URI = 'mysql://root@localhost:3306/mydb';
    process.env.SHINOBIDB_SOURCE_HOST = 'other-host';

    expect(() => readEnvConnection('source')).toThrow(ConfigValidationError);
    expect(() => readEnvConnection('source')).toThrow('mutually exclusive');
  });

  it('should throw when URI has password and PASSWORD env var is also set', () => {
    process.env.SHINOBIDB_SOURCE_URI = 'mysql://root:inuri@localhost:3306/mydb';
    process.env.SHINOBIDB_SOURCE_PASSWORD = 'also-set';

    expect(() => readEnvConnection('source')).toThrow(ConfigValidationError);
    expect(() => readEnvConnection('source')).toThrow('mutually exclusive');
  });

  it('should throw on invalid PORT', () => {
    process.env.SHINOBIDB_SOURCE_PORT = 'abc';

    expect(() => readEnvConnection('source')).toThrow(ConfigValidationError);
    expect(() => readEnvConnection('source')).toThrow('must be a number');
  });

  it('should throw on invalid TYPE', () => {
    process.env.SHINOBIDB_SOURCE_TYPE = 'sqlite';

    expect(() => readEnvConnection('source')).toThrow(ConfigValidationError);
    expect(() => readEnvConnection('source')).toThrow('must be one of');
  });

  it('should allow DATABASE env var to override URI database', () => {
    process.env.SHINOBIDB_SOURCE_URI = 'mysql://root@localhost:3306/original';
    process.env.SHINOBIDB_SOURCE_DATABASE = 'override';

    const result = readEnvConnection('source');
    expect(result.database).toBe('override');
  });

  it('should include password when set to empty string', () => {
    process.env.SHINOBIDB_SOURCE_PASSWORD = '';

    const result = readEnvConnection('source');
    expect(result.password).toBe('');
  });
});
