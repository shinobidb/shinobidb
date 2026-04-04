import type { TableInfo } from '../../db/types.js';
import type { PiiCategory, PiiDetectionResult, PiiDetector } from '../types.js';

interface PatternRule {
  pattern: RegExp;
  category: PiiCategory;
  confidence: number;
  suggestedMaskingStrategy: string;
}

const PATTERN_RULES: PatternRule[] = [
  // Email
  {
    pattern: /e[-_]?mail/i,
    category: 'email',
    confidence: 0.95,
    suggestedMaskingStrategy: 'hash_email',
  },
  // Full name
  {
    pattern: /^(?:full|display|user|customer|member|author|contact)[-_]?name$/i,
    category: 'name',
    confidence: 0.9,
    suggestedMaskingStrategy: 'fake_name',
  },
  { pattern: /^name$/i, category: 'name', confidence: 0.7, suggestedMaskingStrategy: 'fake_name' },
  // First name
  {
    pattern: /first[-_]?name|given[-_]?name|fname/i,
    category: 'first_name',
    confidence: 0.95,
    suggestedMaskingStrategy: 'fake_first_name',
  },
  // Last name
  {
    pattern: /^(?:last[-_]?name|family[-_]?name|surname|lname)$/i,
    category: 'last_name',
    confidence: 0.95,
    suggestedMaskingStrategy: 'fake_last_name',
  },
  // Phone
  {
    pattern: /phone|telephone|(?:^|[-_])tel(?:$|[-_])|mobile|(?:^|[-_])fax(?:$|[-_])/i,
    category: 'phone',
    confidence: 0.9,
    suggestedMaskingStrategy: 'fake_phone',
  },
  // IP address (must precede address to avoid false match)
  {
    pattern: /^(?:ip|ip[-_]addr|ip[-_]address|remote[-_]addr|client[-_]ip|source[-_]ip)$/i,
    category: 'ip_address',
    confidence: 0.85,
    suggestedMaskingStrategy: 'hash_ip',
  },
  // Address
  {
    pattern:
      /address|street|(?:^|[-_])city(?:$|[-_])|(?:^|[-_])state(?:$|[-_])|province|zip[-_]?code|postal[-_]?code|country/i,
    category: 'address',
    confidence: 0.85,
    suggestedMaskingStrategy: 'fake_address',
  },
  // Date of birth
  {
    pattern: /birth[-_]?(day|date)?|(?:^|[-_])dob(?:$|[-_])|date[-_]?of[-_]?birth/i,
    category: 'date_of_birth',
    confidence: 0.9,
    suggestedMaskingStrategy: 'random_date',
  },
  // Credit card
  {
    pattern: /credit[-_]?card|card[-_]?num(ber)?|cc[-_]?num(ber)?|(?:^|[-_])pan(?:$|[-_])/i,
    category: 'credit_card',
    confidence: 0.95,
    suggestedMaskingStrategy: 'redact',
  },
  // SSN
  {
    pattern: /ssn|social[-_]?security|national[-_]?id|my[-_]?number/i,
    category: 'ssn',
    confidence: 0.95,
    suggestedMaskingStrategy: 'redact',
  },
  // Free text (may contain embedded PII)
  {
    pattern:
      /^(?:note|notes|comment|comments|description|bio|biography|about|about[-_]?me|memo|remark|remarks|message|body|content|summary|feedback)$/i,
    category: 'free_text',
    confidence: 0.6,
    suggestedMaskingStrategy: 'scrub_text',
  },
];

export class ColumnNameDetector implements PiiDetector {
  async detect(tables: TableInfo[]): Promise<PiiDetectionResult[]> {
    const results: PiiDetectionResult[] = [];

    for (const table of tables) {
      for (const column of table.columns) {
        if (column.isPrimaryKey || column.isForeignKey) {
          continue;
        }

        const match = this.matchColumn(column.name);
        if (match) {
          results.push({
            schema: table.schema,
            table: table.name,
            column: column.name,
            category: match.category,
            confidence: match.confidence,
            reasoning: `Column name "${column.name}" matches pattern for ${match.category}`,
            suggestedMaskingStrategy: match.suggestedMaskingStrategy,
          });
        }
      }
    }

    return results;
  }

  private matchColumn(columnName: string): PatternRule | null {
    for (const rule of PATTERN_RULES) {
      if (rule.pattern.test(columnName)) {
        return rule;
      }
    }
    return null;
  }
}
