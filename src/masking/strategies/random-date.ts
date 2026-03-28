import { createHash } from 'node:crypto';

import type { MaskingContext, MaskingStrategy } from '../types.js';

export class RandomDateStrategy implements MaskingStrategy {
  readonly name = 'random_date';

  mask(value: unknown, _context: MaskingContext, seed = ''): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    const input = seed ? `${seed}:${String(value)}` : String(value);
    const hash = createHash('sha256').update(input).digest('hex');

    const year = 1950 + (parseInt(hash.slice(0, 4), 16) % 50);
    const month = (parseInt(hash.slice(4, 6), 16) % 12) + 1;
    const day = (parseInt(hash.slice(6, 8), 16) % 28) + 1;

    const m = String(month).padStart(2, '0');
    const d = String(day).padStart(2, '0');

    if (value instanceof Date) {
      return new Date(`${year}-${m}-${d}T00:00:00Z`);
    }

    return `${year}-${m}-${d}`;
  }
}
