import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { ConfigValidationError, MaskingError } from '../../shared/errors.js';
import { extractStrategies, loadCustomStrategies } from '../custom-strategy-loader.js';
import { StrategyRegistry } from '../strategy-registry.js';

describe('extractStrategies', () => {
  it('should extract a single default-export strategy', () => {
    const module = {
      default: {
        name: 'custom_upper',
        mask: (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : v),
      },
    };

    const strategies = extractStrategies(module);
    expect(strategies).toHaveLength(1);
    expect(strategies[0]!.name).toBe('custom_upper');
    expect(strategies[0]!.mask('hello', { schema: '', table: '', column: '', rowIndex: 0 })).toBe(
      'HELLO',
    );
  });

  it('should extract an array default-export', () => {
    const module = {
      default: [
        { name: 'a', mask: () => 'a' },
        { name: 'b', mask: () => 'b' },
      ],
    };

    const strategies = extractStrategies(module);
    expect(strategies).toHaveLength(2);
    expect(strategies.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('should extract named exports', () => {
    const module = {
      strategyA: { name: 'custom_a', mask: (v: unknown) => `a:${v}` },
      strategyB: { name: 'custom_b', mask: (v: unknown) => `b:${v}` },
    };

    const strategies = extractStrategies(module);
    expect(strategies).toHaveLength(2);
  });

  it('should combine default and named exports without duplicates', () => {
    const shared = { name: 'shared', mask: () => 'x' };
    const module = {
      default: shared,
      myExport: shared,
      other: { name: 'other', mask: () => 'y' },
    };

    const strategies = extractStrategies(module);
    expect(strategies).toHaveLength(2);
    expect(strategies.map((s) => s.name).sort()).toEqual(['other', 'shared']);
  });

  it('should skip invalid exports (missing name)', () => {
    const module = {
      default: { mask: () => 'x' },
    };

    const strategies = extractStrategies(module);
    expect(strategies).toHaveLength(0);
  });

  it('should skip invalid exports (missing mask)', () => {
    const module = {
      default: { name: 'broken' },
    };

    const strategies = extractStrategies(module);
    expect(strategies).toHaveLength(0);
  });

  it('should skip invalid exports (empty name)', () => {
    const module = {
      default: { name: '', mask: () => 'x' },
    };

    const strategies = extractStrategies(module);
    expect(strategies).toHaveLength(0);
  });

  it('should skip non-object exports', () => {
    const module = {
      default: 'not a strategy',
      someNumber: 42,
      someNull: null,
    };

    const strategies = extractStrategies(module as Record<string, unknown>);
    expect(strategies).toHaveLength(0);
  });

  it('should skip invalid items in array default-export', () => {
    const module = {
      default: [
        { name: 'valid', mask: () => 'x' },
        { name: 'no_mask' },
        'not an object',
        { mask: () => 'y' },
      ],
    };

    const strategies = extractStrategies(module as Record<string, unknown>);
    expect(strategies).toHaveLength(1);
    expect(strategies[0]!.name).toBe('valid');
  });

  it('should handle empty module', () => {
    const strategies = extractStrategies({});
    expect(strategies).toHaveLength(0);
  });

  it('should pass params from context to strategy', () => {
    const module = {
      default: {
        name: 'custom_prefix',
        mask: (value: unknown, context: { params?: Record<string, unknown> }) => {
          const prefix = context.params?.prefix ?? 'MASKED';
          return `${prefix}_${value}`;
        },
      },
    };

    const strategies = extractStrategies(module);
    expect(strategies).toHaveLength(1);

    const result = strategies[0]!.mask('Alice', {
      schema: 'db',
      table: 'users',
      column: 'name',
      rowIndex: 0,
      params: { prefix: 'ANON' },
    });
    expect(result).toBe('ANON_Alice');

    const resultNoParams = strategies[0]!.mask('Alice', {
      schema: 'db',
      table: 'users',
      column: 'name',
      rowIndex: 0,
    });
    expect(resultNoParams).toBe('MASKED_Alice');
  });
});

describe('loadCustomStrategies', () => {
  let registry: StrategyRegistry;
  let tmpDir: string;

  beforeEach(() => {
    registry = new StrategyRegistry();
    tmpDir = resolve(
      tmpdir(),
      `shinobidb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should load a valid CJS strategy file', async () => {
    const filePath = resolve(tmpDir, 'my-strategy.cjs');
    writeFileSync(
      filePath,
      `module.exports = {
        name: 'test_strategy',
        mask(value) { return 'masked_' + value; },
      };`,
    );

    await loadCustomStrategies(['my-strategy.cjs'], registry, tmpDir);

    expect(registry.has('test_strategy')).toBe(true);
    const strategy = registry.get('test_strategy');
    expect(strategy.mask('hello', { schema: '', table: '', column: '', rowIndex: 0 })).toBe(
      'masked_hello',
    );
  });

  it('should load multiple files', async () => {
    writeFileSync(
      resolve(tmpDir, 'a.cjs'),
      `module.exports = { name: 'strat_a', mask: v => 'a:' + v };`,
    );
    writeFileSync(
      resolve(tmpDir, 'b.cjs'),
      `module.exports = { name: 'strat_b', mask: v => 'b:' + v };`,
    );

    await loadCustomStrategies(['a.cjs', 'b.cjs'], registry, tmpDir);

    expect(registry.has('strat_a')).toBe(true);
    expect(registry.has('strat_b')).toBe(true);
  });

  it('should throw ConfigValidationError for non-existent file', async () => {
    await expect(loadCustomStrategies(['nonexistent.js'], registry, tmpDir)).rejects.toThrow(
      ConfigValidationError,
    );
    await expect(loadCustomStrategies(['nonexistent.js'], registry, tmpDir)).rejects.toThrow(
      'Custom strategy file not found',
    );
  });

  it('should throw MaskingError for file with syntax error', async () => {
    writeFileSync(resolve(tmpDir, 'bad.cjs'), 'module.exports = {{{');

    await expect(loadCustomStrategies(['bad.cjs'], registry, tmpDir)).rejects.toThrow(MaskingError);
    await expect(loadCustomStrategies(['bad.cjs'], registry, tmpDir)).rejects.toThrow(
      'Failed to load custom strategy file',
    );
  });

  it('should throw ConfigValidationError for file with no valid strategies', async () => {
    writeFileSync(resolve(tmpDir, 'empty.cjs'), `module.exports.default = { notAStrategy: true };`);

    await expect(loadCustomStrategies(['empty.cjs'], registry, tmpDir)).rejects.toThrow(
      ConfigValidationError,
    );
    await expect(loadCustomStrategies(['empty.cjs'], registry, tmpDir)).rejects.toThrow(
      'does not export any valid MaskingStrategy',
    );
  });

  it('should throw ConfigValidationError when strategy name conflicts', async () => {
    writeFileSync(
      resolve(tmpDir, 'conflict.cjs'),
      `module.exports = { name: 'existing', mask: v => v };`,
    );

    registry.register({ name: 'existing', mask: (v: unknown) => v });

    await expect(loadCustomStrategies(['conflict.cjs'], registry, tmpDir)).rejects.toThrow(
      ConfigValidationError,
    );
    await expect(loadCustomStrategies(['conflict.cjs'], registry, tmpDir)).rejects.toThrow(
      'conflicts with an existing strategy',
    );
  });

  it('should handle empty paths array', async () => {
    await loadCustomStrategies([], registry, tmpDir);
    expect(registry.getAll()).toHaveLength(0);
  });

  it('should load named exports from CJS', async () => {
    writeFileSync(
      resolve(tmpDir, 'named.cjs'),
      `module.exports.stratA = { name: 'named_a', mask: v => 'a:' + v };
       module.exports.stratB = { name: 'named_b', mask: v => 'b:' + v };`,
    );

    await loadCustomStrategies(['named.cjs'], registry, tmpDir);

    expect(registry.has('named_a')).toBe(true);
    expect(registry.has('named_b')).toBe(true);
  });
});
