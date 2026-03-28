import { UnsupportedDatabaseError } from '../shared/errors.js';
import type { DatabaseConnectionConfig } from '../shared/types.js';

import { MySQLAdapter } from './mysql/mysql-adapter.js';
import type { DatabaseAdapter } from './types.js';

export function createAdapter(config: DatabaseConnectionConfig): DatabaseAdapter {
  switch (config.type) {
    case 'mysql':
      return new MySQLAdapter(config);
    default: {
      const _exhaustive: never = config.type;
      throw new UnsupportedDatabaseError(String(_exhaustive));
    }
  }
}
