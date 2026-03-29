import type { DatabaseAdapter, TableInfo } from '../../db/types.js';
import { logger } from '../../shared/logger.js';
import type { PiiCategory, PiiDetectionResult, PiiDetector } from '../types.js';

interface ContentPattern {
  pattern: RegExp;
  category: PiiCategory;
  suggestedMaskingStrategy: string;
}

const CONTENT_PATTERNS: ContentPattern[] = [
  {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    category: 'email',
    suggestedMaskingStrategy: 'hash_email',
  },
  {
    // eslint-disable-next-line security/detect-unsafe-regex
    pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/,
    category: 'phone',
    suggestedMaskingStrategy: 'fake_phone',
  },
  {
    // eslint-disable-next-line security/detect-unsafe-regex
    pattern: /(?:^|\b)(?:\d{1,3}\.){3}\d{1,3}(?:\b|$)/,
    category: 'ip_address',
    suggestedMaskingStrategy: 'hash_ip',
  },
  {
    pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,
    category: 'credit_card',
    suggestedMaskingStrategy: 'redact',
  },
  {
    pattern: /\b\d{3}[-. ]?\d{2}[-. ]?\d{4}\b/,
    category: 'ssn',
    suggestedMaskingStrategy: 'redact',
  },
];

// Exclude columns with numeric-only data types from text pattern matching
const NUMERIC_TYPES =
  /^(int|integer|bigint|smallint|tinyint|float|double|decimal|numeric|real|serial|number)/i;

export class ContentDetector implements PiiDetector {
  private adapter: DatabaseAdapter;
  private sampleSize: number;

  constructor(adapter: DatabaseAdapter, sampleSize: number = 100) {
    this.adapter = adapter;
    this.sampleSize = sampleSize;
  }

  async detect(tables: TableInfo[]): Promise<PiiDetectionResult[]> {
    const results: PiiDetectionResult[] = [];

    for (const table of tables) {
      const textColumns = table.columns.filter(
        (col) => !col.isPrimaryKey && !col.isForeignKey && !NUMERIC_TYPES.test(col.dataType),
      );

      if (textColumns.length === 0) continue;

      const sampleRows: Record<string, unknown>[] = [];
      try {
        await this.adapter.readRows(table.schema, table.name, this.sampleSize, async (rows) => {
          sampleRows.push(...rows);
          return false; // stop after first batch
        });
      } catch (err) {
        logger.debug(
          `Content sampling failed for ${table.schema}.${table.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      if (sampleRows.length === 0) continue;

      for (const col of textColumns) {
        const values = sampleRows
          .map((row) => row[col.name])
          .filter((v): v is string => typeof v === 'string' && v.length > 0);

        if (values.length === 0) continue;

        const detection = this.detectInValues(values, table, col.name);
        if (detection) {
          results.push(detection);
        }
      }
    }

    return results;
  }

  private detectInValues(
    values: string[],
    table: TableInfo,
    columnName: string,
  ): PiiDetectionResult | null {
    const matchCounts = new Map<PiiCategory, { count: number; pattern: ContentPattern }>();

    for (const value of values) {
      for (const cp of CONTENT_PATTERNS) {
        if (cp.pattern.test(value)) {
          const existing = matchCounts.get(cp.category);
          if (existing) {
            existing.count++;
          } else {
            matchCounts.set(cp.category, { count: 1, pattern: cp });
          }
        }
      }
    }

    if (matchCounts.size === 0) return null;

    // Find the category with the highest match ratio
    let bestCategory: PiiCategory | null = null;
    let bestRatio = 0;
    let bestPattern: ContentPattern | null = null;

    for (const [category, { count, pattern }] of matchCounts) {
      const ratio = count / values.length;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestCategory = category;
        bestPattern = pattern;
      }
    }

    if (!bestCategory || !bestPattern) return null;

    // Require at least 10% of sampled values to match to avoid false positives
    const MIN_MATCH_RATIO = 0.1;
    if (bestRatio < MIN_MATCH_RATIO) return null;

    // Confidence scales with match ratio: 10% matches → 0.5, 100% matches → 0.9
    const confidence = Math.min(0.5 + bestRatio * 0.4, 0.9);
    const matchCount = matchCounts.get(bestCategory)!.count;

    return {
      schema: table.schema,
      table: table.name,
      column: columnName,
      category: bestCategory,
      confidence: Math.round(confidence * 100) / 100,
      reasoning: `Content sampling: ${matchCount}/${values.length} values match ${bestCategory} pattern`,
      suggestedMaskingStrategy: bestPattern.suggestedMaskingStrategy,
    };
  }
}
