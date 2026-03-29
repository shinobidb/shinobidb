import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ShinobiConfig } from '../config/types.js';
import { loadCustomStrategies } from '../masking/custom-strategy-loader.js';
import type { StrategyRegistry } from '../masking/strategy-registry.js';

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export async function validateConfigDeep(
  config: ShinobiConfig,
  registry: StrategyRegistry,
  configDir: string,
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  // 1. Load custom strategies (validates file existence + structure)
  if (config.customStrategies && config.customStrategies.length > 0) {
    try {
      await loadCustomStrategies(config.customStrategies, registry, configDir);
    } catch (err) {
      issues.push({
        level: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Validate strategy names exist in registry
  for (const table of config.tables) {
    if (table.copyOnly) continue;
    for (const col of table.columns) {
      if (!registry.has(col.strategy)) {
        issues.push({
          level: 'error',
          message: `Unknown strategy "${col.strategy}" for ${table.schema}.${table.table}.${col.name}`,
        });
      }
    }
  }

  // 3. Detect duplicate table entries
  const tableKeys = new Map<string, number>();
  for (let i = 0; i < config.tables.length; i++) {
    const key = `${config.tables[i]!.schema}.${config.tables[i]!.table}`;
    if (tableKeys.has(key)) {
      issues.push({
        level: 'error',
        message: `Duplicate table entry: "${key}" at index ${tableKeys.get(key)} and ${i}`,
      });
    } else {
      tableKeys.set(key, i);
    }
  }

  // 4. Detect duplicate column names within a table
  for (const table of config.tables) {
    if (table.copyOnly) continue;
    const colNames = new Set<string>();
    for (const col of table.columns) {
      if (colNames.has(col.name)) {
        issues.push({
          level: 'error',
          message: `Duplicate column "${col.name}" in ${table.schema}.${table.table}`,
        });
      }
      colNames.add(col.name);
    }
  }

  // 5. Warn if source and target DB types differ
  if (config.source.type !== config.target.type) {
    issues.push({
      level: 'warning',
      message: `Source type "${config.source.type}" differs from target type "${config.target.type}". Cross-DB masking may have type compatibility issues`,
    });
  }

  // 6. Warn if source and target point to same host+port+database
  if (
    config.source.host === config.target.host &&
    config.source.port === config.target.port &&
    config.source.database === config.target.database
  ) {
    issues.push({
      level: 'warning',
      message: 'Source and target point to the same database. This will overwrite production data!',
    });
  }

  // 7. Validate incremental column is not also a masked column
  for (const table of config.tables) {
    if (!table.incremental || table.copyOnly) continue;
    const maskedCol = table.columns.find((c) => c.name === table.incremental!.column);
    if (maskedCol) {
      issues.push({
        level: 'error',
        message: `Incremental column "${table.incremental.column}" in ${table.schema}.${table.table} is also masked with "${maskedCol.strategy}". This will corrupt sync state`,
      });
    }
  }

  // 8. Validate customStrategies file paths (if not already caught by loadCustomStrategies)
  if (config.customStrategies) {
    for (const filePath of config.customStrategies) {
      const absolutePath = resolve(configDir, filePath);
      if (!existsSync(absolutePath)) {
        // Only add if not already reported
        const alreadyReported = issues.some((i) => i.message.includes(filePath));
        if (!alreadyReported) {
          issues.push({
            level: 'error',
            message: `Custom strategy file not found: "${filePath}"`,
          });
        }
      }
    }
  }

  return {
    valid: issues.filter((i) => i.level === 'error').length === 0,
    issues,
  };
}
