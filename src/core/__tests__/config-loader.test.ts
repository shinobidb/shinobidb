import { ConfigValidationError } from '../../shared/errors.js';
import { validateConfig } from '../config-loader.js';

const validConfig = {
  version: '1',
  source: {
    type: 'mysql',
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
  },
  target: {
    type: 'mysql',
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
  },
  options: {
    batchSize: 1000,
    deterministic: true,
    seed: 'test',
    truncateTarget: true,
  },
  tables: [
    {
      schema: 'db',
      table: 'users',
      columns: [{ name: 'email', strategy: 'hash_email' }],
    },
  ],
};

function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

describe('validateConfig', () => {
  it('should accept valid config', () => {
    const result = validateConfig(clone(validConfig));
    expect(result.version).toBe('1');
  });

  it('should reject null', () => {
    expect(() => validateConfig(null)).toThrow(ConfigValidationError);
  });

  it('should reject non-object', () => {
    expect(() => validateConfig('string')).toThrow(ConfigValidationError);
  });

  it('should reject wrong version', () => {
    const cfg = clone(validConfig);
    (cfg as Record<string, unknown>).version = '2';
    expect(() => validateConfig(cfg)).toThrow('Unsupported config version');
  });

  it('should reject missing source', () => {
    const cfg = clone(validConfig);
    (cfg as Record<string, unknown>).source = null;
    expect(() => validateConfig(cfg)).toThrow('"source" must be an object');
  });

  it('should reject missing source.host', () => {
    const cfg = clone(validConfig);
    (cfg.source as Record<string, unknown>).host = 123;
    expect(() => validateConfig(cfg)).toThrow('"source.host" must be a string');
  });

  it('should reject non-number port', () => {
    const cfg = clone(validConfig);
    (cfg.source as Record<string, unknown>).port = '3306';
    expect(() => validateConfig(cfg)).toThrow('"source.port" must be a number');
  });

  it('should reject missing options', () => {
    const cfg = clone(validConfig);
    (cfg as Record<string, unknown>).options = null;
    expect(() => validateConfig(cfg)).toThrow('"options" must be an object');
  });

  it('should reject non-number batchSize', () => {
    const cfg = clone(validConfig);
    (cfg.options as Record<string, unknown>).batchSize = 'big';
    expect(() => validateConfig(cfg)).toThrow('"options.batchSize" must be a number');
  });

  it('should reject non-array tables', () => {
    const cfg = clone(validConfig);
    (cfg as Record<string, unknown>).tables = 'not-array';
    expect(() => validateConfig(cfg)).toThrow('"tables" must be an array');
  });

  it('should reject table without schema', () => {
    const cfg = clone(validConfig);
    (cfg.tables[0] as Record<string, unknown>).schema = 123;
    expect(() => validateConfig(cfg)).toThrow('"tables[0].schema" must be a string');
  });

  it('should reject column without strategy', () => {
    const cfg = clone(validConfig);
    (cfg.tables[0]!.columns[0] as Record<string, unknown>).strategy = 42;
    expect(() => validateConfig(cfg)).toThrow('"tables[0].columns[0].strategy" must be a string');
  });

  it('should accept postgres type', () => {
    const cfg = clone(validConfig);
    (cfg.source as Record<string, unknown>).type = 'postgres';
    (cfg.target as Record<string, unknown>).type = 'postgres';
    const result = validateConfig(cfg);
    expect(result.source.type).toBe('postgres');
  });

  it('should reject unsupported database type', () => {
    const cfg = clone(validConfig);
    (cfg.source as Record<string, unknown>).type = 'oracle';
    expect(() => validateConfig(cfg)).toThrow('"source.type" must be one of: mysql, postgres');
  });

  it('should accept empty tables array', () => {
    const cfg = clone(validConfig);
    cfg.tables = [];
    const result = validateConfig(cfg);
    expect(result.tables).toHaveLength(0);
  });
});
