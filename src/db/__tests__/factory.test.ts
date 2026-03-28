import type { DatabaseConnectionConfig } from '../../shared/types.js';
import { createAdapter } from '../factory.js';
import { MySQLAdapter } from '../mysql/mysql-adapter.js';

// Mock logger
jest.mock('../../shared/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    output: jest.fn(),
  },
}));

describe('createAdapter', () => {
  it('should create a MySQLAdapter for mysql type', () => {
    const config: DatabaseConnectionConfig = {
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: 'test',
    };

    const adapter = createAdapter(config);
    expect(adapter).toBeInstanceOf(MySQLAdapter);
  });

  it('should throw for unsupported database type', () => {
    const config = {
      type: 'postgres' as DatabaseConnectionConfig['type'],
      host: 'localhost',
      port: 5432,
      user: 'root',
      password: 'test',
    };

    expect(() => createAdapter(config)).toThrow('Unsupported database type');
  });
});
