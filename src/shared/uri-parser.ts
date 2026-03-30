import type { DatabaseConnectionConfig, DatabaseType } from './types.js';

const DEFAULT_PORTS: Record<DatabaseType, number> = {
  mysql: 3306,
  postgres: 5432,
  mongodb: 27017,
};

const SCHEME_TO_TYPE: Record<string, DatabaseType> = {
  mysql: 'mysql',
  postgres: 'postgres',
  postgresql: 'postgres',
  mongodb: 'mongodb',
  'mongodb+srv': 'mongodb',
};

export function parseUri(uri: string): DatabaseConnectionConfig {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error('Invalid connection URI format');
  }

  const scheme = url.protocol.replace(/:$/, '');
  const dbType = SCHEME_TO_TYPE[scheme];
  if (!dbType) {
    throw new Error(
      `Unsupported URI scheme "${scheme}". Supported: ${Object.keys(SCHEME_TO_TYPE).join(', ')}`,
    );
  }

  const host = url.hostname;
  if (!host) {
    throw new Error('URI must include a hostname');
  }

  const user = decodeURIComponent(url.username);
  if (!user) {
    throw new Error('URI must include a username');
  }

  const password = url.password ? decodeURIComponent(url.password) : '';
  const port = url.port ? parseInt(url.port, 10) : DEFAULT_PORTS[dbType];
  const database = url.pathname.replace(/^\//, '') || undefined;

  return {
    type: dbType,
    host,
    port,
    user,
    password,
    database,
  };
}
