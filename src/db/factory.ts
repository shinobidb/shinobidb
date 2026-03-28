import { UnsupportedDatabaseError } from '../shared/errors.js';
import type { DatabaseConnectionConfig } from '../shared/types.js';

import { MongoDBAdapter } from './mongodb/mongodb-adapter.js';
import { MySQLAdapter } from './mysql/mysql-adapter.js';
import { PostgresAdapter } from './postgres/postgres-adapter.js';
import type { DatabaseAdapter } from './types.js';

export function createAdapter(config: DatabaseConnectionConfig): DatabaseAdapter {
  switch (config.type) {
    case 'mysql':
      return new MySQLAdapter(config);
    case 'postgres':
      return new PostgresAdapter(config);
    case 'mongodb':
      return new MongoDBAdapter(config);
    default: {
      const _exhaustive: never = config.type;
      throw new UnsupportedDatabaseError(String(_exhaustive));
    }
  }
}
