import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

import type { ShinobiConfig } from '../config/types.js';
import { ConfigFileError, ConfigValidationError } from '../shared/errors.js';
import { parseUri } from '../shared/uri-parser.js';

export async function loadConfig(filePath: string): Promise<ShinobiConfig> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new ConfigFileError(`Failed to read config file: ${filePath}`, err);
  }

  return loadConfigFromString(content, filePath);
}

export function loadConfigFromString(content: string, source = '<string>'): ShinobiConfig {
  let raw: unknown;
  try {
    raw = parse(content);
  } catch (err) {
    throw new ConfigFileError(`Failed to parse YAML: ${source}`, err);
  }

  return validateConfig(raw);
}

export function validateConfig(raw: unknown): ShinobiConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigValidationError('Config must be a YAML object');
  }

  const obj = raw as Record<string, unknown>;

  if (obj.version !== '1') {
    throw new ConfigValidationError(
      `Unsupported config version: ${String(obj.version)}. Expected "1"`,
    );
  }

  validateConnectionConfig(obj.source, 'source');
  validateConnectionConfig(obj.target, 'target');
  validateOptions(obj.options);
  validateTables(obj.tables);
  validateCustomStrategies(obj.customStrategies);

  return raw as ShinobiConfig;
}

function validateConnectionConfig(value: unknown, name: string): void {
  if (value === null || typeof value !== 'object') {
    throw new ConfigValidationError(`"${name}" must be an object`);
  }

  const conn = value as Record<string, unknown>;

  if (typeof conn.uri === 'string') {
    // URI mode: resolve uri into individual fields
    const hasIndividualFields =
      conn.host !== undefined || conn.port !== undefined || conn.user !== undefined;
    if (hasIndividualFields) {
      throw new ConfigValidationError(
        `"${name}" has both "uri" and individual connection fields (host/port/user). These are mutually exclusive`,
      );
    }

    const parsed = parseUri(conn.uri);
    conn.type = parsed.type;
    conn.host = parsed.host;
    conn.port = parsed.port;
    conn.user = parsed.user;
    if (parsed.password) {
      conn.password = parsed.password;
    }
    if (!conn.password) {
      conn.password = '';
    }
    if (parsed.database) {
      conn.database = parsed.database;
    }
    return;
  }

  const requiredStrings = ['type', 'host', 'user', 'password'] as const;

  for (const field of requiredStrings) {
    if (typeof conn[field] !== 'string') {
      throw new ConfigValidationError(`"${name}.${field}" must be a string`);
    }
  }

  const supportedTypes = ['mysql', 'postgres', 'mongodb'];
  if (!supportedTypes.includes(conn.type as string)) {
    throw new ConfigValidationError(
      `"${name}.type" must be one of: ${supportedTypes.join(', ')}. Got "${String(conn.type)}"`,
    );
  }

  if (typeof conn.port !== 'number') {
    throw new ConfigValidationError(`"${name}.port" must be a number`);
  }
}

function validateOptions(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    throw new ConfigValidationError('"options" must be an object');
  }

  const opts = value as Record<string, unknown>;

  if (typeof opts.batchSize !== 'number') {
    throw new ConfigValidationError('"options.batchSize" must be a number');
  }
  if (typeof opts.deterministic !== 'boolean') {
    throw new ConfigValidationError('"options.deterministic" must be a boolean');
  }
  if (typeof opts.seed !== 'string') {
    throw new ConfigValidationError('"options.seed" must be a string');
  }
  if (typeof opts.truncateTarget !== 'boolean') {
    throw new ConfigValidationError('"options.truncateTarget" must be a boolean');
  }
}

function validateTables(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError('"tables" must be an array');
  }

  for (let i = 0; i < value.length; i++) {
    const table = value[i] as Record<string, unknown>;

    if (typeof table.schema !== 'string') {
      throw new ConfigValidationError(`"tables[${i}].schema" must be a string`);
    }
    if (typeof table.table !== 'string') {
      throw new ConfigValidationError(`"tables[${i}].table" must be a string`);
    }
    if (table.copyOnly !== undefined && typeof table.copyOnly !== 'boolean') {
      throw new ConfigValidationError(`"tables[${i}].copyOnly" must be a boolean`);
    }

    if (table.incremental !== undefined) {
      validateIncremental(table.incremental, i);
    }

    if (table.copyOnly === true) {
      if (table.columns !== undefined && Array.isArray(table.columns) && table.columns.length > 0) {
        throw new ConfigValidationError(
          `"tables[${i}]" has copyOnly: true but also defines columns. These are mutually exclusive`,
        );
      }
      continue;
    }

    if (!Array.isArray(table.columns)) {
      throw new ConfigValidationError(`"tables[${i}].columns" must be an array`);
    }

    for (let j = 0; j < table.columns.length; j++) {
      const col = table.columns[j] as Record<string, unknown>;
      if (typeof col.name !== 'string') {
        throw new ConfigValidationError(`"tables[${i}].columns[${j}].name" must be a string`);
      }
      if (typeof col.strategy !== 'string') {
        throw new ConfigValidationError(`"tables[${i}].columns[${j}].strategy" must be a string`);
      }
    }
  }
}

function validateCustomStrategies(value: unknown): void {
  if (value === undefined) return;

  if (!Array.isArray(value)) {
    throw new ConfigValidationError('"customStrategies" must be an array of file paths');
  }

  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string' || value[i].length === 0) {
      throw new ConfigValidationError(
        `"customStrategies[${i}]" must be a non-empty string (file path)`,
      );
    }
  }
}

function validateIncremental(value: unknown, tableIndex: number): void {
  if (typeof value !== 'object' || value === null) {
    throw new ConfigValidationError(`"tables[${tableIndex}].incremental" must be an object`);
  }

  const inc = value as Record<string, unknown>;

  const validStrategies = ['timestamp', 'cursor'];
  if (!validStrategies.includes(inc.strategy as string)) {
    throw new ConfigValidationError(
      `"tables[${tableIndex}].incremental.strategy" must be one of: ${validStrategies.join(', ')}`,
    );
  }

  if (typeof inc.column !== 'string' || inc.column.length === 0) {
    throw new ConfigValidationError(
      `"tables[${tableIndex}].incremental.column" must be a non-empty string`,
    );
  }
}
