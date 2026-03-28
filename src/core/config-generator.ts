import { stringify } from 'yaml';

import type { ShinobiConfig, TableMaskConfig } from '../config/types.js';
import { logger } from '../shared/logger.js';
import type { DatabaseConnectionConfig } from '../shared/types.js';

import type { ScanResult } from './scanner.js';

export interface GenerateConfigOptions {
  source?: Partial<DatabaseConnectionConfig>;
  target?: Partial<DatabaseConnectionConfig>;
  minConfidence?: number;
  batchSize?: number;
  deterministic?: boolean;
  seed?: string;
  truncateTarget?: boolean;
}

const DEFAULT_CONNECTION: DatabaseConnectionConfig = {
  type: 'mysql',
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: '',
};

export function generateConfig(
  scanResult: ScanResult,
  options: GenerateConfigOptions = {},
): ShinobiConfig {
  const minConfidence = options.minConfidence ?? 0.5;

  const filteredDetections = scanResult.detections.filter((d) => d.confidence >= minConfidence);

  logger.info(
    `Generating config for ${filteredDetections.length} detection(s) (minConfidence: ${minConfidence})`,
  );

  const tableMap = new Map<string, TableMaskConfig>();

  for (const detection of filteredDetections) {
    const key = `${detection.schema}.${detection.table}`;
    let tableConfig = tableMap.get(key);

    if (!tableConfig) {
      tableConfig = {
        schema: detection.schema,
        table: detection.table,
        columns: [],
      };
      tableMap.set(key, tableConfig);
    }

    tableConfig.columns.push({
      name: detection.column,
      strategy: detection.suggestedMaskingStrategy,
    });
  }

  const tables = Array.from(tableMap.values());

  const config: ShinobiConfig = {
    version: '1',
    source: {
      ...DEFAULT_CONNECTION,
      ...options.source,
    } as DatabaseConnectionConfig,
    target: {
      ...DEFAULT_CONNECTION,
      ...options.target,
    } as DatabaseConnectionConfig,
    options: {
      batchSize: options.batchSize ?? 1000,
      deterministic: options.deterministic ?? true,
      seed: options.seed ?? 'shinobidb-default-seed',
      truncateTarget: options.truncateTarget ?? true,
    },
    tables,
  };

  logger.success(
    `Config generated: ${tables.length} table(s), ${filteredDetections.length} column(s)`,
  );

  return config;
}

export function configToYaml(config: ShinobiConfig): string {
  return stringify(config, {
    lineWidth: 120,
  });
}
