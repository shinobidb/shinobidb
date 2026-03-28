import { createHash } from 'node:crypto';

import type { MaskingContext, MaskingStrategy } from '../types.js';

export class HashEmailStrategy implements MaskingStrategy {
  readonly name = 'hash_email';

  mask(value: unknown, _context: MaskingContext, seed?: string): unknown {
    if (typeof value !== 'string' || value === '') {
      return value;
    }

    const parts = value.split('@');
    const domain = parts.length > 1 ? parts[parts.length - 1] : 'example.com';
    const input = seed ? `${seed}:${value}` : value;
    const hash = createHash('sha256').update(input).digest('hex').slice(0, 12);

    return `${hash}@${domain}`;
  }
}
