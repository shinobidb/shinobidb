export interface MaskingContext {
  schema: string;
  table: string;
  column: string;
  rowIndex: number;
  primaryKeyValue?: unknown;
}

export interface MaskingStrategy {
  readonly name: string;
  mask(value: unknown, context: MaskingContext, seed?: string): unknown;
}
