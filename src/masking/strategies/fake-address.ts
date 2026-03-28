import { createHash } from 'node:crypto';

import type { MaskingContext, MaskingStrategy } from '../types.js';

const STREETS = [
  'Main St',
  'Oak Ave',
  'Elm St',
  'Park Blvd',
  'Maple Dr',
  'Cedar Ln',
  'Pine St',
  'Washington Ave',
  'Lake Rd',
  'Hill St',
];

const CITIES = [
  'Springfield',
  'Riverside',
  'Fairview',
  'Madison',
  'Georgetown',
  'Clinton',
  'Arlington',
  'Salem',
  'Franklin',
  'Chester',
];

export class FakeAddressStrategy implements MaskingStrategy {
  readonly name = 'fake_address';

  mask(value: unknown, _context: MaskingContext, seed = ''): unknown {
    if (typeof value !== 'string' || value === '') {
      return value;
    }

    const input = `${seed}:${value}`;
    const hash = createHash('sha256').update(input).digest('hex');

    const num = (parseInt(hash.slice(0, 4), 16) % 9999) + 1;
    const streetIdx = parseInt(hash.slice(4, 8), 16) % STREETS.length;
    const cityIdx = parseInt(hash.slice(8, 12), 16) % CITIES.length;

    return `${num} ${STREETS[streetIdx]!}, ${CITIES[cityIdx]!}`;
  }
}
