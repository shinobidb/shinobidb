import { createHash } from 'node:crypto';

import type { MaskingContext, MaskingStrategy } from '../types.js';

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /\+\d{1,3}[\s-]\d{2,4}[\s-]\d{3,4}[\s-]\d{4}/g;
const IP_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

export class ScrubTextStrategy implements MaskingStrategy {
  readonly name = 'scrub_text';

  mask(value: unknown, _context: MaskingContext, seed?: string): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'string' || value === '') {
      return value;
    }

    // Use placeholder approach to prevent later patterns from matching earlier replacements
    const placeholders: string[] = [];
    const placeholder = (replacement: string): string => {
      const idx = placeholders.length;
      placeholders.push(replacement);
      return `\x00PH${idx}\x00`;
    };

    let result = value;

    result = result.replace(EMAIL_PATTERN, (match) => {
      const domain = match.split('@')[1] ?? 'example.com';
      const input = seed ? `${seed}:${match}` : match;
      const hash = createHash('sha256').update(input).digest('hex').slice(0, 8);
      return placeholder(`${hash}@${domain}`);
    });

    result = result.replace(IP_PATTERN, (match) => {
      const input = seed ? `${seed}:${match}` : match;
      const hash = createHash('sha256').update(input).digest('hex');
      const octets = [0, 2, 4, 6].map((i) => (parseInt(hash.slice(i, i + 2), 16) % 254) + 1);
      return placeholder(octets.join('.'));
    });

    result = result.replace(PHONE_PATTERN, (match) => {
      const input = seed ? `${seed}:${match}` : match;
      const hash = createHash('sha256').update(input).digest('hex');
      const digits = hash.replace(/\D/g, '').slice(0, 10);
      return placeholder(`+1-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`);
    });

    // Restore placeholders
    result = result.replace(/\x00PH(\d+)\x00/g, (_match, idx) => placeholders[Number(idx)]!);

    return result;
  }
}
