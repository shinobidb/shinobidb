import { readEnvConnection, type PartialConnectionConfig } from './env-config.js';
import { ConfigValidationError } from './errors.js';
import { isInteractiveTerminal, promptPassword } from './password-prompt.js';
import type { DatabaseConnectionConfig, DatabaseType } from './types.js';
import { parseUri } from './uri-parser.js';

export interface ResolveConnectionOptions {
  uri?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  type?: string;
  database?: string;
  configConnection?: DatabaseConnectionConfig;
  role: 'source' | 'target';
  /** Override for testing — if provided, skips the default isInteractiveTerminal/promptPassword */
  passwordProvider?: () => Promise<string>;
}

function mergePartial(
  base: PartialConnectionConfig,
  overlay: PartialConnectionConfig,
): PartialConnectionConfig {
  const result = { ...base };
  if (overlay.type !== undefined) result.type = overlay.type;
  if (overlay.host !== undefined) result.host = overlay.host;
  if (overlay.port !== undefined) result.port = overlay.port;
  if (overlay.user !== undefined) result.user = overlay.user;
  if (overlay.password !== undefined) result.password = overlay.password;
  if (overlay.database !== undefined) result.database = overlay.database;
  return result;
}

function cliToPartial(opts: ResolveConnectionOptions): PartialConnectionConfig {
  if (opts.uri) {
    const hasIndividual =
      opts.host !== undefined || opts.port !== undefined || opts.user !== undefined;
    if (hasIndividual) {
      throw new ConfigValidationError('--uri and --host/--port/--user are mutually exclusive');
    }
    const parsed = parseUri(opts.uri);
    if (opts.password) {
      if (parsed.password) {
        throw new ConfigValidationError(
          'Password specified both in URI and via --password. These are mutually exclusive',
        );
      }
      parsed.password = opts.password;
    }
    if (opts.database) {
      parsed.database = opts.database;
    }
    return parsed;
  }

  const result: PartialConnectionConfig = {};
  if (opts.type) result.type = opts.type as DatabaseType;
  if (opts.host) result.host = opts.host;
  if (opts.port !== undefined) result.port = opts.port;
  if (opts.user) result.user = opts.user;
  if (opts.password !== undefined) result.password = opts.password;
  if (opts.database) result.database = opts.database;
  return result;
}

export async function resolveConnection(
  opts: ResolveConnectionOptions,
): Promise<DatabaseConnectionConfig> {
  // Layer 1: Config file (lowest priority)
  let merged: PartialConnectionConfig = opts.configConnection ? { ...opts.configConnection } : {};

  // Layer 2: Environment variables
  const envPartial = readEnvConnection(opts.role);
  merged = mergePartial(merged, envPartial);

  // Layer 3: CLI flags (highest priority)
  const cliPartial = cliToPartial(opts);
  merged = mergePartial(merged, cliPartial);

  // Layer 4: Interactive password prompt if still missing
  if (merged.password === undefined) {
    if (opts.passwordProvider) {
      merged.password = await opts.passwordProvider();
    } else if (isInteractiveTerminal()) {
      merged.password = await promptPassword(`Enter ${opts.role} password: `);
    } else {
      const prefix = `SHINOBIDB_${opts.role.toUpperCase()}_PASSWORD`;
      throw new ConfigValidationError(
        `Password required for ${opts.role} connection. ` +
          `Provide via --${opts.role === 'source' ? 'source-' : 'target-'}password, ${prefix}, or in config file (-c)`,
      );
    }
  }

  // Validate required fields
  if (!merged.host) {
    throw new ConfigValidationError(
      `Host required for ${opts.role} connection. Provide via --host, --uri, environment variable, or config file (-c)`,
    );
  }
  if (merged.port === undefined) {
    throw new ConfigValidationError(
      `Port required for ${opts.role} connection. Provide via --port, --uri, environment variable, or config file (-c)`,
    );
  }
  if (!merged.user) {
    throw new ConfigValidationError(
      `User required for ${opts.role} connection. Provide via --user, --uri, environment variable, or config file (-c)`,
    );
  }

  return {
    type: merged.type ?? 'mysql',
    host: merged.host,
    port: merged.port,
    user: merged.user,
    password: merged.password,
    database: merged.database,
  };
}
