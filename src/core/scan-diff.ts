import type { PiiDetectionResult } from '../detection/types.js';

import type { ScanResult } from './scanner.js';

export interface ScanDiffResult {
  added: PiiDetectionResult[];
  removed: PiiDetectionResult[];
  changed: ScanDiffChange[];
  unchanged: number;
}

export interface ScanDiffChange {
  column: { schema: string; table: string; column: string };
  before: { category: string; confidence: number; strategy: string };
  after: { category: string; confidence: number; strategy: string };
}

function detectionKey(d: PiiDetectionResult): string {
  return `${d.schema}.${d.table}.${d.column}`;
}

export function diffScans(baseline: ScanResult, current: ScanResult): ScanDiffResult {
  const baselineMap = new Map<string, PiiDetectionResult>();
  for (const d of baseline.detections) {
    baselineMap.set(detectionKey(d), d);
  }

  const currentMap = new Map<string, PiiDetectionResult>();
  for (const d of current.detections) {
    currentMap.set(detectionKey(d), d);
  }

  const added: PiiDetectionResult[] = [];
  const removed: PiiDetectionResult[] = [];
  const changed: ScanDiffChange[] = [];
  let unchanged = 0;

  for (const [key, cur] of currentMap) {
    const base = baselineMap.get(key);
    if (!base) {
      added.push(cur);
    } else if (
      base.category !== cur.category ||
      base.confidence !== cur.confidence ||
      base.suggestedMaskingStrategy !== cur.suggestedMaskingStrategy
    ) {
      changed.push({
        column: { schema: cur.schema, table: cur.table, column: cur.column },
        before: {
          category: base.category,
          confidence: base.confidence,
          strategy: base.suggestedMaskingStrategy,
        },
        after: {
          category: cur.category,
          confidence: cur.confidence,
          strategy: cur.suggestedMaskingStrategy,
        },
      });
    } else {
      unchanged++;
    }
  }

  for (const [key, base] of baselineMap) {
    if (!currentMap.has(key)) {
      removed.push(base);
    }
  }

  return { added, removed, changed, unchanged };
}
