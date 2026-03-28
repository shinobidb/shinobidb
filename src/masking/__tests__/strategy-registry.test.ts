import { MaskingError } from '../../shared/errors.js';
import { StrategyRegistry, createDefaultRegistry } from '../strategy-registry.js';
import type { MaskingStrategy } from '../types.js';

describe('StrategyRegistry', () => {
  it('should register and retrieve a strategy', () => {
    const registry = new StrategyRegistry();
    const mockStrategy: MaskingStrategy = {
      name: 'test',
      mask: (v: unknown) => v,
    };

    registry.register(mockStrategy);

    expect(registry.get('test')).toBe(mockStrategy);
    expect(registry.has('test')).toBe(true);
  });

  it('should throw MaskingError for unknown strategy', () => {
    const registry = new StrategyRegistry();

    expect(() => registry.get('nonexistent')).toThrow(MaskingError);
    expect(() => registry.get('nonexistent')).toThrow('Unknown masking strategy: "nonexistent"');
  });

  it('should report has correctly', () => {
    const registry = new StrategyRegistry();
    expect(registry.has('anything')).toBe(false);
  });

  it('should return all registered strategies', () => {
    const registry = new StrategyRegistry();
    const s1: MaskingStrategy = { name: 'a', mask: (v: unknown) => v };
    const s2: MaskingStrategy = { name: 'b', mask: (v: unknown) => v };

    registry.register(s1);
    registry.register(s2);

    expect(registry.getAll()).toHaveLength(2);
  });
});

describe('createDefaultRegistry', () => {
  it('should contain all built-in strategies', () => {
    const registry = createDefaultRegistry();

    const expectedStrategies = [
      'hash_email',
      'fake_name',
      'fake_first_name',
      'fake_last_name',
      'fake_phone',
      'fake_address',
      'redact',
      'random_date',
      'hash_ip',
      'scrub_text',
    ];

    for (const name of expectedStrategies) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('should return 10 strategies', () => {
    const registry = createDefaultRegistry();
    expect(registry.getAll()).toHaveLength(10);
  });
});
