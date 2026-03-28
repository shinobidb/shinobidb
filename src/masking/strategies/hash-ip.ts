import { createHash } from 'node:crypto';

import type { MaskingContext, MaskingStrategy } from '../types.js';

export class HashIpStrategy implements MaskingStrategy {
  readonly name = 'hash_ip';

  mask(value: unknown, _context: MaskingContext, seed = ''): unknown {
    if (typeof value !== 'string' || value === '') {
      return value;
    }

    const input = seed ? `${seed}:${value}` : value;
    const hash = createHash('sha256').update(input).digest('hex');

    const octets = [
      parseInt(hash.slice(0, 2), 16),
      parseInt(hash.slice(2, 4), 16),
      parseInt(hash.slice(4, 6), 16),
      parseInt(hash.slice(6, 8), 16),
    ];

    return `${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}`;
  }
}
