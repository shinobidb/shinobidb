import type { MaskingContext, MaskingStrategy } from '../types.js';

export class RedactStrategy implements MaskingStrategy {
  readonly name = 'redact';

  mask(value: unknown, _context: MaskingContext, _seed?: string): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return '***REDACTED***';
    }

    if (typeof value === 'number') {
      return 0;
    }

    return '***REDACTED***';
  }
}
