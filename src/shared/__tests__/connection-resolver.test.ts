import { resolveConnection } from '../connection-resolver.js';
import { ConfigValidationError } from '../errors.js';
import type { DatabaseConnectionConfig } from '../types.js';

describe('resolveConnection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear all SHINOBIDB env vars
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith('SHINOBIDB_')) delete process.env[key];
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const fullConfig: DatabaseConnectionConfig = {
    type: 'mysql',
    host: 'config-host',
    port: 3306,
    user: 'config-user',
    password: 'config-pass',
    database: 'config-db',
  };

  describe('resolution priority', () => {
    it('should use config file as base', async () => {
      const result = await resolveConnection({
        role: 'source',
        configConnection: fullConfig,
      });

      expect(result.host).toBe('config-host');
      expect(result.user).toBe('config-user');
      expect(result.password).toBe('config-pass');
    });

    it('should override config with env vars', async () => {
      process.env.SHINOBIDB_SOURCE_HOST = 'env-host';
      process.env.SHINOBIDB_SOURCE_PASSWORD = 'env-pass';

      const result = await resolveConnection({
        role: 'source',
        configConnection: fullConfig,
      });

      expect(result.host).toBe('env-host');
      expect(result.password).toBe('env-pass');
      // Non-overridden fields stay from config
      expect(result.user).toBe('config-user');
      expect(result.port).toBe(3306);
    });

    it('should override env vars with CLI flags', async () => {
      process.env.SHINOBIDB_SOURCE_HOST = 'env-host';
      process.env.SHINOBIDB_SOURCE_PASSWORD = 'env-pass';

      const result = await resolveConnection({
        role: 'source',
        configConnection: fullConfig,
        host: 'cli-host',
        password: 'cli-pass',
      });

      expect(result.host).toBe('cli-host');
      expect(result.password).toBe('cli-pass');
    });

    it('should use all three layers together (CLI > env > config)', async () => {
      process.env.SHINOBIDB_SOURCE_USER = 'env-user';
      process.env.SHINOBIDB_SOURCE_PASSWORD = 'env-pass';

      const result = await resolveConnection({
        role: 'source',
        configConnection: fullConfig,
        password: 'cli-pass',
      });

      // CLI wins for password
      expect(result.password).toBe('cli-pass');
      // Env wins for user (over config)
      expect(result.user).toBe('env-user');
      // Config provides host and port (no override)
      expect(result.host).toBe('config-host');
      expect(result.port).toBe(3306);
    });
  });

  describe('CLI flags', () => {
    it('should resolve from CLI flags only', async () => {
      const result = await resolveConnection({
        role: 'source',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'secret',
        type: 'mysql',
        database: 'mydb',
      });

      expect(result).toEqual({
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'secret',
        database: 'mydb',
      });
    });

    it('should resolve from CLI URI', async () => {
      const result = await resolveConnection({
        role: 'source',
        uri: 'postgres://admin:pass@db.example.com:5432/appdb',
      });

      expect(result.type).toBe('postgres');
      expect(result.host).toBe('db.example.com');
      expect(result.password).toBe('pass');
    });

    it('should throw when URI and individual flags are mixed', async () => {
      await expect(
        resolveConnection({
          role: 'source',
          uri: 'mysql://root@localhost:3306/mydb',
          host: 'other',
        }),
      ).rejects.toThrow('mutually exclusive');
    });
  });

  describe('password resolution', () => {
    it('should use passwordProvider when password is missing', async () => {
      const provider = jest.fn().mockResolvedValue('prompted-pass');

      const result = await resolveConnection({
        role: 'source',
        host: 'localhost',
        port: 3306,
        user: 'root',
        passwordProvider: provider,
      });

      expect(provider).toHaveBeenCalled();
      expect(result.password).toBe('prompted-pass');
    });

    it('should throw when non-interactive and password is missing', async () => {
      await expect(
        resolveConnection({
          role: 'source',
          host: 'localhost',
          port: 3306,
          user: 'root',
        }),
      ).rejects.toThrow(ConfigValidationError);
    });

    it('should not prompt when password is provided via config', async () => {
      const provider = jest.fn().mockResolvedValue('should-not-be-called');

      const result = await resolveConnection({
        role: 'source',
        configConnection: fullConfig,
        passwordProvider: provider,
      });

      expect(result.password).toBe('config-pass');
      expect(provider).not.toHaveBeenCalled();
    });

    it('should not prompt when password is provided via env var', async () => {
      process.env.SHINOBIDB_SOURCE_PASSWORD = 'env-pass';
      const provider = jest.fn().mockResolvedValue('should-not-be-called');

      const result = await resolveConnection({
        role: 'source',
        host: 'localhost',
        port: 3306,
        user: 'root',
        passwordProvider: provider,
      });

      expect(result.password).toBe('env-pass');
      expect(provider).not.toHaveBeenCalled();
    });

    it('should accept empty string password without prompting', async () => {
      const provider = jest.fn().mockResolvedValue('should-not-be-called');

      const result = await resolveConnection({
        role: 'source',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: '',
        passwordProvider: provider,
      });

      expect(result.password).toBe('');
      expect(provider).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('should throw when host is missing', async () => {
      await expect(
        resolveConnection({
          role: 'source',
          port: 3306,
          user: 'root',
          password: 'pass',
        }),
      ).rejects.toThrow('Host required');
    });

    it('should throw when port is missing', async () => {
      await expect(
        resolveConnection({
          role: 'source',
          host: 'localhost',
          user: 'root',
          password: 'pass',
        }),
      ).rejects.toThrow('Port required');
    });

    it('should throw when user is missing', async () => {
      await expect(
        resolveConnection({
          role: 'source',
          host: 'localhost',
          port: 3306,
          password: 'pass',
        }),
      ).rejects.toThrow('User required');
    });

    it('should default type to mysql', async () => {
      const result = await resolveConnection({
        role: 'source',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'pass',
      });

      expect(result.type).toBe('mysql');
    });
  });

  describe('target role', () => {
    it('should read target env vars', async () => {
      process.env.SHINOBIDB_TARGET_HOST = 'target-host';
      process.env.SHINOBIDB_TARGET_PORT = '3307';
      process.env.SHINOBIDB_TARGET_USER = 'target-user';
      process.env.SHINOBIDB_TARGET_PASSWORD = 'target-pass';

      const result = await resolveConnection({ role: 'target' });

      expect(result.host).toBe('target-host');
      expect(result.port).toBe(3307);
      expect(result.user).toBe('target-user');
      expect(result.password).toBe('target-pass');
    });
  });

  describe('error messages', () => {
    it('should include source-password in error for source role', async () => {
      await expect(
        resolveConnection({
          role: 'source',
          host: 'localhost',
          port: 3306,
          user: 'root',
        }),
      ).rejects.toThrow('--source-password');
    });

    it('should include target-password in error for target role', async () => {
      await expect(
        resolveConnection({
          role: 'target',
          host: 'localhost',
          port: 3306,
          user: 'root',
        }),
      ).rejects.toThrow('--target-password');
    });
  });
});
