import type { ColumnMaskConfig, MaskOptions, ShinobiConfig, TableMaskConfig } from '../types.js';

describe('config types', () => {
  it('should allow constructing ColumnMaskConfig', () => {
    const col: ColumnMaskConfig = {
      name: 'email',
      strategy: 'faker-email',
      params: { locale: 'ja' },
    };

    expect(col.strategy).toBe('faker-email');
    expect(col.params).toEqual({ locale: 'ja' });
  });

  it('should allow ColumnMaskConfig without params', () => {
    const col: ColumnMaskConfig = {
      name: 'email',
      strategy: 'faker-email',
    };

    expect(col.params).toBeUndefined();
  });

  it('should allow constructing TableMaskConfig', () => {
    const table: TableMaskConfig = {
      schema: 'myapp',
      table: 'users',
      columns: [{ name: 'email', strategy: 'faker-email' }],
    };

    expect(table.columns).toHaveLength(1);
  });

  it('should allow constructing full ShinobiConfig', () => {
    const config: ShinobiConfig = {
      version: '1',
      source: {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'pass',
        database: 'myapp',
      },
      target: {
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'pass',
        database: 'myapp_staging',
      },
      options: {
        batchSize: 1000,
        deterministic: true,
        seed: 'shinobi-2026',
        truncateTarget: true,
      },
      tables: [],
    };

    expect(config.version).toBe('1');
    expect(config.source.type).toBe('mysql');
    expect(config.options.batchSize).toBe(1000);
  });

  it('should type-check MaskOptions', () => {
    const opts: MaskOptions = {
      batchSize: 500,
      deterministic: false,
      seed: 'test',
      truncateTarget: false,
    };

    expect(opts.deterministic).toBe(false);
  });
});
