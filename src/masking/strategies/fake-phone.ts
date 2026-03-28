import { createHash } from 'node:crypto';

import type { MaskingContext, MaskingStrategy } from '../types.js';

export class FakePhoneStrategy implements MaskingStrategy {
  readonly name = 'fake_phone';

  mask(value: unknown, _context: MaskingContext, seed = ''): unknown {
    if (typeof value !== 'string' || value === '') {
      return value;
    }

    const input = seed ? `${seed}:${value}` : value;
    const hash = createHash('sha256').update(input).digest('hex');

    const digits = hash.replace(/\D/g, '').slice(0, 10);
    return `+1-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
  }
}
