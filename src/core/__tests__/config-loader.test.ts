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
    expect(() => validateConfig(cfg)).toThrow(
      '"source.type" must be one of: mysql, postgres, mongodb',
    );
  });

  it('should accept empty tables array', () => {
    const cfg = clone(validConfig);
    cfg.tables = [];
    const result = validateConfig(cfg);
    expect(result.tables).toHaveLength(0);
  });

  it('should accept copyOnly table without columns', () => {
    const cfg = clone(validConfig) as Record<string, unknown>;
    cfg.tables = [{ schema: 'db', table: 'prefectures', copyOnly: true }];
    const result = validateConfig(cfg);
    expect(result.tables[0]!.copyOnly).toBe(true);
  });

  it('should accept copyOnly table with empty columns array', () => {
    const cfg = clone(validConfig) as Record<string, unknown>;
    cfg.tables = [{ schema: 'db', table: 'prefectures', copyOnly: true, columns: [] }];
    const result = validateConfig(cfg);
    expect(result.tables[0]!.copyOnly).toBe(true);
  });

  it('should reject copyOnly table with non-empty columns', () => {
    const cfg = clone(validConfig) as Record<string, unknown>;
    cfg.tables = [
      {
        schema: 'db',
        table: 'users',
        copyOnly: true,
        columns: [{ name: 'email', strategy: 'hash_email' }],
      },
    ];
    expect(() => validateConfig(cfg)).toThrow('copyOnly: true but also defines columns');
  });

  it('should accept URI in connection config', () => {
    const cfg = clone(validConfig) as Record<string, unknown>;
    cfg.source = { uri: 'mysql://root:pass@localhost:3306/mydb' };
    const result = validateConfig(cfg);
    expect(result.source.type).toBe('mysql');
    expect(result.source.host).toBe('localhost');
    expect(result.source.port).toBe(3306);
    expect(result.source.user).toBe('root');
    expect(result.source.password).toBe('pass');
    expect(result.source.database).toBe('mydb');
  });

  it('should reject URI with individual connection fields', () => {
    const cfg = clone(validConfig) as Record<string, unknown>;
    cfg.source = { uri: 'mysql://root:pass@localhost:3306/db', host: 'other-host' };
    expect(() => validateConfig(cfg)).toThrow('mutually exclusive');
  });

  it('should set empty password when URI has no password', () => {
    const cfg = clone(validConfig) as Record<string, unknown>;
    cfg.source = { uri: 'mysql://root@localhost:3306/mydb' };
    const result = validateConfig(cfg);
    expect(result.source.password).toBe('');
  });

  it('should reject non-boolean copyOnly', () => {
    const cfg = clone(validConfig);
    (cfg.tables[0] as Record<string, unknown>).copyOnly = 'yes';
    expect(() => validateConfig(cfg)).toThrow('"tables[0].copyOnly" must be a boolean');
  });

  it('should accept table with incremental timestamp config', () => {
    const cfg = clone(validConfig);
    (cfg.tables[0] as Record<string, unknown>).incremental = {
      strategy: 'timestamp',
      column: 'updated_at',
    };
    const result = validateConfig(cfg);
    expect(result.tables[0]!.incremental).toEqual({
      strategy: 'timestamp',
      column: 'updated_at',
    });
  });

  it('should accept table with incremental cursor config', () => {
    const cfg = clone(validConfig);
    (cfg.tables[0] as Record<string, unknown>).incremental = {
      strategy: 'cursor',
      column: 'id',
    };
    const result = validateConfig(cfg);
    expect(result.tables[0]!.incremental!.strategy).toBe('cursor');
  });

  it('should reject incremental with invalid strategy', () => {
    const cfg = clone(validConfig);
    (cfg.tables[0] as Record<string, unknown>).incremental = {
      strategy: 'invalid',
      column: 'id',
    };
    expect(() => validateConfig(cfg)).toThrow(
      '"tables[0].incremental.strategy" must be one of: timestamp, cursor',
    );
  });

  it('should reject incremental with missing column', () => {
    const cfg = clone(validConfig);
    (cfg.tables[0] as Record<string, unknown>).incremental = {
      strategy: 'timestamp',
    };
    expect(() => validateConfig(cfg)).toThrow(
      '"tables[0].incremental.column" must be a non-empty string',
    );
  });

  it('should reject incremental with empty column', () => {
    const cfg = clone(validConfig);
    (cfg.tables[0] as Record<string, unknown>).incremental = {
      strategy: 'cursor',
      column: '',
    };
    expect(() => validateConfig(cfg)).toThrow(
      '"tables[0].incremental.column" must be a non-empty string',
    );
  });

  it('should reject non-object incremental', () => {
    const cfg = clone(validConfig);
    (cfg.tables[0] as Record<string, unknown>).incremental = 'yes';
    expect(() => validateConfig(cfg)).toThrow('"tables[0].incremental" must be an object');
  });

  it('should accept table without incremental (backward compatible)', () => {
    const cfg = clone(validConfig);
    const result = validateConfig(cfg);
    expect(result.tables[0]!.incremental).toBeUndefined();
  });

  it('should accept config with customStrategies array', () => {
    const cfg = clone(validConfig);
    (cfg as Record<string, unknown>).customStrategies = ['./my-strategy.js'];
    const result = validateConfig(cfg);
    expect(result.customStrategies).toEqual(['./my-strategy.js']);
  });

  it('should accept config without customStrategies (backward compatible)', () => {
    const cfg = clone(validConfig);
    const result = validateConfig(cfg);
    expect(result.customStrategies).toBeUndefined();
  });

  it('should reject customStrategies that is not an array', () => {
    const cfg = clone(validConfig);
    (cfg as Record<string, unknown>).customStrategies = './my-strategy.js';
    expect(() => validateConfig(cfg)).toThrow('"customStrategies" must be an array');
  });

  it('should reject customStrategies with non-string entries', () => {
    const cfg = clone(validConfig);
    (cfg as Record<string, unknown>).customStrategies = [123];
    expect(() => validateConfig(cfg)).toThrow('"customStrategies[0]" must be a non-empty string');
  });

  it('should reject customStrategies with empty string entries', () => {
    const cfg = clone(validConfig);
    (cfg as Record<string, unknown>).customStrategies = [''];
    expect(() => validateConfig(cfg)).toThrow('"customStrategies[0]" must be a non-empty string');
  });
});
