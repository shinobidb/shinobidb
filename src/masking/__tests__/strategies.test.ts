import { FakeAddressStrategy } from '../strategies/fake-address.js';
import {
  FakeNameStrategy,
  FakeFirstNameStrategy,
  FakeLastNameStrategy,
} from '../strategies/fake-name.js';
import { FakePhoneStrategy } from '../strategies/fake-phone.js';
import { HashEmailStrategy } from '../strategies/hash-email.js';
import { HashIpStrategy } from '../strategies/hash-ip.js';
import { RandomDateStrategy } from '../strategies/random-date.js';
import { RedactStrategy } from '../strategies/redact.js';
import type { MaskingContext } from '../types.js';

const ctx: MaskingContext = {
  schema: 'db',
  table: 'users',
  column: 'test',
  rowIndex: 0,
};

describe('HashEmailStrategy', () => {
  const strategy = new HashEmailStrategy();

  it('should preserve domain', () => {
    const result = strategy.mask('user@example.com', ctx, 'seed');
    expect(result).toMatch(/@example\.com$/);
  });

  it('should produce deterministic output with same seed', () => {
    const a = strategy.mask('user@example.com', ctx, 'seed');
    const b = strategy.mask('user@example.com', ctx, 'seed');
    expect(a).toBe(b);
  });

  it('should produce different output with different seeds', () => {
    const a = strategy.mask('user@example.com', ctx, 'seed1');
    const b = strategy.mask('user@example.com', ctx, 'seed2');
    expect(a).not.toBe(b);
  });

  it('should pass through non-string values', () => {
    expect(strategy.mask(null, ctx)).toBeNull();
    expect(strategy.mask(42, ctx)).toBe(42);
    expect(strategy.mask('', ctx)).toBe('');
  });
});

describe('FakeNameStrategy', () => {
  const strategy = new FakeNameStrategy();

  it('should return first + last name', () => {
    const result = strategy.mask('John Doe', ctx, 'seed') as string;
    expect(result).toMatch(/^\w+ \w+$/);
  });

  it('should be deterministic with same seed', () => {
    const a = strategy.mask('John Doe', ctx, 'seed');
    const b = strategy.mask('John Doe', ctx, 'seed');
    expect(a).toBe(b);
  });

  it('should pass through non-string values', () => {
    expect(strategy.mask(null, ctx)).toBeNull();
    expect(strategy.mask('', ctx)).toBe('');
  });
});

describe('FakeFirstNameStrategy', () => {
  const strategy = new FakeFirstNameStrategy();

  it('should return a single name', () => {
    const result = strategy.mask('John', ctx, 'seed') as string;
    expect(result).toMatch(/^\w+$/);
  });

  it('should be deterministic', () => {
    const a = strategy.mask('John', ctx, 'seed');
    const b = strategy.mask('John', ctx, 'seed');
    expect(a).toBe(b);
  });
});

describe('FakeLastNameStrategy', () => {
  const strategy = new FakeLastNameStrategy();

  it('should return a single name', () => {
    const result = strategy.mask('Doe', ctx, 'seed') as string;
    expect(result).toMatch(/^\w+$/);
  });
});

describe('FakePhoneStrategy', () => {
  const strategy = new FakePhoneStrategy();

  it('should return formatted phone number', () => {
    const result = strategy.mask('+81-90-1234-5678', ctx, 'seed') as string;
    expect(result).toMatch(/^\+1-\d{3}-\d{3}-\d{4}$/);
  });

  it('should be deterministic', () => {
    const a = strategy.mask('090-1234-5678', ctx, 'seed');
    const b = strategy.mask('090-1234-5678', ctx, 'seed');
    expect(a).toBe(b);
  });
});

describe('FakeAddressStrategy', () => {
  const strategy = new FakeAddressStrategy();

  it('should return an address-like string', () => {
    const result = strategy.mask('123 Real St', ctx, 'seed') as string;
    expect(result).toMatch(/^\d+ .+, \w+$/);
  });

  it('should be deterministic', () => {
    const a = strategy.mask('123 Real St', ctx, 'seed');
    const b = strategy.mask('123 Real St', ctx, 'seed');
    expect(a).toBe(b);
  });
});

describe('RedactStrategy', () => {
  const strategy = new RedactStrategy();

  it('should redact strings', () => {
    expect(strategy.mask('secret', ctx)).toBe('***REDACTED***');
  });

  it('should redact numbers to 0', () => {
    expect(strategy.mask(12345, ctx)).toBe(0);
  });

  it('should pass through null/undefined', () => {
    expect(strategy.mask(null, ctx)).toBeNull();
    expect(strategy.mask(undefined, ctx)).toBeUndefined();
  });
});

describe('RandomDateStrategy', () => {
  const strategy = new RandomDateStrategy();

  it('should return date string in YYYY-MM-DD format', () => {
    const result = strategy.mask('1990-01-15', ctx, 'seed') as string;
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('should return Date object when input is Date', () => {
    const result = strategy.mask(new Date('1990-01-15'), ctx, 'seed');
    expect(result).toBeInstanceOf(Date);
  });

  it('should be deterministic', () => {
    const a = strategy.mask('1990-01-15', ctx, 'seed');
    const b = strategy.mask('1990-01-15', ctx, 'seed');
    expect(a).toBe(b);
  });

  it('should pass through null', () => {
    expect(strategy.mask(null, ctx)).toBeNull();
  });
});

describe('HashIpStrategy', () => {
  const strategy = new HashIpStrategy();

  it('should return IPv4-like string', () => {
    const result = strategy.mask('192.168.1.1', ctx, 'seed') as string;
    expect(result).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('should be deterministic', () => {
    const a = strategy.mask('10.0.0.1', ctx, 'seed');
    const b = strategy.mask('10.0.0.1', ctx, 'seed');
    expect(a).toBe(b);
  });

  it('should pass through non-string values', () => {
    expect(strategy.mask(null, ctx)).toBeNull();
    expect(strategy.mask('', ctx)).toBe('');
  });
});
