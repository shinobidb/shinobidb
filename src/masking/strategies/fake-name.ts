import { createHash } from 'node:crypto';

import type { MaskingContext, MaskingStrategy } from '../types.js';

const FIRST_NAMES = [
  'James',
  'Mary',
  'John',
  'Patricia',
  'Robert',
  'Jennifer',
  'Michael',
  'Linda',
  'David',
  'Elizabeth',
  'William',
  'Barbara',
  'Richard',
  'Susan',
  'Joseph',
  'Jessica',
  'Thomas',
  'Sarah',
  'Charles',
  'Karen',
];

const LAST_NAMES = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
];

function pickFromList(list: readonly string[], value: string, seed: string): string {
  const input = `${seed}:${value}`;
  const hash = createHash('sha256').update(input).digest('hex');
  const index = parseInt(hash.slice(0, 8), 16) % list.length;
  return list[index]!;
}

export class FakeNameStrategy implements MaskingStrategy {
  readonly name = 'fake_name';

  mask(value: unknown, _context: MaskingContext, seed = ''): unknown {
    if (typeof value !== 'string' || value === '') {
      return value;
    }

    const first = pickFromList(FIRST_NAMES, value, `${seed}:first`);
    const last = pickFromList(LAST_NAMES, value, `${seed}:last`);
    return `${first} ${last}`;
  }
}

export class FakeFirstNameStrategy implements MaskingStrategy {
  readonly name = 'fake_first_name';

  mask(value: unknown, _context: MaskingContext, seed = ''): unknown {
    if (typeof value !== 'string' || value === '') {
      return value;
    }
    return pickFromList(FIRST_NAMES, value, seed);
  }
}

export class FakeLastNameStrategy implements MaskingStrategy {
  readonly name = 'fake_last_name';

  mask(value: unknown, _context: MaskingContext, seed = ''): unknown {
    if (typeof value !== 'string' || value === '') {
      return value;
    }
    return pickFromList(LAST_NAMES, value, seed);
  }
}
