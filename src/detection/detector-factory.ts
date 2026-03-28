import { ColumnNameDetector } from './detectors/column-name-detector.js';
import type { PiiDetector } from './types.js';

export function createDefaultDetectors(): PiiDetector[] {
  return [new ColumnNameDetector()];
}
