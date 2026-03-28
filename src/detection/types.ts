import type { TableInfo } from '../db/types.js';

export type PiiCategory =
  | 'email'
  | 'name'
  | 'first_name'
  | 'last_name'
  | 'phone'
  | 'address'
  | 'date_of_birth'
  | 'ip_address'
  | 'credit_card'
  | 'ssn'
  | 'free_text'
  | 'unknown';

export interface PiiDetectionResult {
  schema: string;
  table: string;
  column: string;
  category: PiiCategory;
  confidence: number;
  reasoning: string;
  suggestedMaskingStrategy: string;
}

export interface PiiDetector {
  detect(tables: TableInfo[]): Promise<PiiDetectionResult[]>;
}
