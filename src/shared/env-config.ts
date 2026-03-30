import { ConfigValidationError } from './errors.js';
import type { DatabaseType } from './types.js';
import { parseUri } from './uri-parser.js';

export interface PartialConnectionConfig {
  type?: DatabaseType;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

export function readEnvConnection(role: 'source' | 'target'): PartialConnectionConfig {
  const prefix = `SHINOBIDB_${role.toUpperCase()}_`;

  const uri = process.env[`${prefix}URI`];
  const host = process.env[`${prefix}HOST`];
  const portStr = process.env[`${prefix}PORT`];
  const user = process.env[`${prefix}USER`];
  const password = process.env[`${prefix}PASSWORD`];
  const database = process.env[`${prefix}DATABASE`];
  const type = process.env[`${prefix}TYPE`] as DatabaseType | undefined;

  if (uri) {
    const hasIndividual = host !== undefined || portStr !== undefined || user !== undefined;
    if (hasIndividual) {
      throw new ConfigValidationError(
        `${prefix}URI and ${prefix}HOST/${prefix}PORT/${prefix}USER are mutually exclusive`,
      );
    }

    const parsed = parseUri(uri);

    if (parsed.password && password) {
      throw new ConfigValidationError(
        `Password specified both in ${prefix}URI and ${prefix}PASSWORD. These are mutually exclusive`,
      );
    }

    return {
      type: parsed.type,
      host: parsed.host,
      port: parsed.port,
      user: parsed.user,
      password: password ?? parsed.password,
      database: database ?? parsed.database,
    };
  }

  const result: PartialConnectionConfig = {};

  if (type) {
    const supported = ['mysql', 'postgres', 'mongodb'];
    if (!supported.includes(type)) {
      throw new ConfigValidationError(
        `${prefix}TYPE must be one of: ${supported.join(', ')}. Got "${type}"`,
      );
    }
    result.type = type;
  }
  if (host) result.host = host;
  if (portStr) {
    const port = parseInt(portStr, 10);
    if (isNaN(port)) {
      throw new ConfigValidationError(`${prefix}PORT must be a number. Got "${portStr}"`);
    }
    result.port = port;
  }
  if (user) result.user = user;
  if (password !== undefined) result.password = password;
  if (database) result.database = database;

  return result;
}
