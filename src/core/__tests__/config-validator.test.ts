import type { ShinobiConfig } from '../../config/types.js';
import { createDefaultRegistry } from '../../masking/strategy-registry.js';
import type { StrategyRegistry } from '../../masking/strategy-registry.js';
import { validateConfigDeep } from '../config-validator.js';

function makeConfig(overrides: Partial<ShinobiConfig> = {}): ShinobiConfig {
  return {
    version: '1',
    source: {
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: '',
      database: 'source_db',
    },
    target: {
      type: 'mysql',
      host: 'localhost',
      port: 3307,
      user: 'root',
      password: '',
      database: 'target_db',
    },
    options: {
      batchSize: 1000,
      deterministic: true,
      seed: 'test-seed',
      truncateTarget: true,
    },
    tables: [
      {
        schema: 'source_db',
        table: 'users',
        columns: [
          { name: 'email', strategy: 'hash_email' },
          { name: 'first_name', strategy: 'fake_first_name' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('validateConfigDeep', () => {
  let registry: StrategyRegistry;

  beforeEach(() => {
    registry = createDefaultRegistry();
  });

  it('should pass for a valid config', async () => {
    const config = makeConfig();
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('should detect unknown strategy', async () => {
    const config = makeConfig({
      tables: [
        {
          schema: 'db',
          table: 'users',
          columns: [{ name: 'email', strategy: 'nonexistent_strategy' }],
        },
      ],
    });
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.level).toBe('error');
    expect(result.issues[0]!.message).toContain('Unknown strategy "nonexistent_strategy"');
  });

  it('should detect multiple unknown strategies', async () => {
    const config = makeConfig({
      tables: [
        {
          schema: 'db',
          table: 'users',
          columns: [
            { name: 'email', strategy: 'bad_one' },
            { name: 'phone', strategy: 'bad_two' },
          ],
        },
      ],
    });
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(false);
    expect(result.issues.filter((i) => i.level === 'error')).toHaveLength(2);
  });

  it('should skip strategy validation for copyOnly tables', async () => {
    const config = makeConfig({
      tables: [
        {
          schema: 'db',
          table: 'master_data',
          columns: [],
          copyOnly: true,
        },
      ],
    });
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(true);
  });

  it('should detect duplicate table entries', async () => {
    const config = makeConfig({
      tables: [
        {
          schema: 'db',
          table: 'users',
          columns: [{ name: 'email', strategy: 'hash_email' }],
        },
        {
          schema: 'db',
          table: 'users',
          columns: [{ name: 'phone', strategy: 'fake_phone' }],
        },
      ],
    });
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(false);
    expect(result.issues[0]!.message).toContain('Duplicate table entry: "db.users"');
  });

  it('should detect duplicate column names', async () => {
    const config = makeConfig({
      tables: [
        {
          schema: 'db',
          table: 'users',
          columns: [
            { name: 'email', strategy: 'hash_email' },
            { name: 'email', strategy: 'redact' },
          ],
        },
      ],
    });
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(false);
    expect(result.issues[0]!.message).toContain('Duplicate column "email"');
  });

  it('should warn when source and target DB types differ', async () => {
    const config = makeConfig();
    config.target.type = 'postgres';
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(true);
    const warnings = result.issues.filter((i) => i.level === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain(
      'Source type "mysql" differs from target type "postgres"',
    );
  });

  it('should warn when source and target point to same database', async () => {
    const config = makeConfig();
    config.target.host = config.source.host;
    config.target.port = config.source.port;
    config.target.database = config.source.database;
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(true);
    const warnings = result.issues.filter((i) => i.level === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('overwrite production data');
  });

  it('should error when incremental column is also masked', async () => {
    const config = makeConfig({
      tables: [
        {
          schema: 'db',
          table: 'users',
          columns: [
            { name: 'email', strategy: 'hash_email' },
            { name: 'updated_at', strategy: 'random_date' },
          ],
          incremental: { strategy: 'timestamp', column: 'updated_at' },
        },
      ],
    });
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(false);
    expect(result.issues[0]!.message).toContain('Incremental column "updated_at"');
    expect(result.issues[0]!.message).toContain('corrupt sync state');
  });

  it('should not error when incremental column is not masked', async () => {
    const config = makeConfig({
      tables: [
        {
          schema: 'db',
          table: 'users',
          columns: [{ name: 'email', strategy: 'hash_email' }],
          incremental: { strategy: 'timestamp', column: 'updated_at' },
        },
      ],
    });
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(true);
  });

  it('should error for non-existent custom strategy file', async () => {
    const config = makeConfig({
      customStrategies: ['./does-not-exist.js'],
    });
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes('does-not-exist.js'))).toBe(true);
  });

  it('should collect multiple issues at once', async () => {
    const config = makeConfig({
      tables: [
        {
          schema: 'db',
          table: 'users',
          columns: [
            { name: 'email', strategy: 'nonexistent' },
            { name: 'email', strategy: 'hash_email' },
          ],
        },
        {
          schema: 'db',
          table: 'users',
          columns: [{ name: 'phone', strategy: 'fake_phone' }],
        },
      ],
    });
    config.target.type = 'postgres';

    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(false);
    // unknown strategy + duplicate column + duplicate table + type mismatch warning
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });

  it('should handle config with no tables', async () => {
    const config = makeConfig({ tables: [] });
    const result = await validateConfigDeep(config, registry, '/tmp');

    expect(result.valid).toBe(true);
  });
});
