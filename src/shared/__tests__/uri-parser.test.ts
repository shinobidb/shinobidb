import { parseUri } from '../uri-parser.js';

describe('parseUri', () => {
  it('should parse MySQL URI', () => {
    const result = parseUri('mysql://root:pass@localhost:3306/mydb');
    expect(result).toEqual({
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: 'pass',
      database: 'mydb',
    });
  });

  it('should parse PostgreSQL URI', () => {
    const result = parseUri('postgres://admin:secret@db.example.com:5432/appdb');
    expect(result).toEqual({
      type: 'postgres',
      host: 'db.example.com',
      port: 5432,
      user: 'admin',
      password: 'secret',
      database: 'appdb',
    });
  });

  it('should accept postgresql:// scheme', () => {
    const result = parseUri('postgresql://user:pass@host:5432/db');
    expect(result.type).toBe('postgres');
  });

  it('should parse MongoDB URI', () => {
    const result = parseUri('mongodb://user:pass@mongo.example.com:27017/testdb');
    expect(result).toEqual({
      type: 'mongodb',
      host: 'mongo.example.com',
      port: 27017,
      user: 'user',
      password: 'pass',
      database: 'testdb',
    });
  });

  it('should accept mongodb+srv:// scheme', () => {
    const result = parseUri('mongodb+srv://user:pass@cluster.mongodb.net/db');
    expect(result.type).toBe('mongodb');
  });

  it('should use default port when not specified', () => {
    expect(parseUri('mysql://root:pass@localhost/db').port).toBe(3306);
    expect(parseUri('postgres://user:pass@localhost/db').port).toBe(5432);
    expect(parseUri('mongodb://user:pass@localhost/db').port).toBe(27017);
  });

  it('should handle URI without password', () => {
    const result = parseUri('mysql://root@localhost:3306/db');
    expect(result.password).toBe('');
    expect(result.user).toBe('root');
  });

  it('should handle URI without database', () => {
    const result = parseUri('mysql://root:pass@localhost:3306');
    expect(result.database).toBeUndefined();
  });

  it('should decode URL-encoded username and password', () => {
    const result = parseUri('mysql://user%40domain:p%40ss%23word@localhost:3306/db');
    expect(result.user).toBe('user@domain');
    expect(result.password).toBe('p@ss#word');
  });

  it('should throw for invalid URI', () => {
    expect(() => parseUri('not-a-uri')).toThrow('Invalid connection URI');
  });

  it('should throw for unsupported scheme', () => {
    expect(() => parseUri('oracle://user:pass@localhost/db')).toThrow('Unsupported URI scheme');
  });

  it('should throw when hostname is missing', () => {
    expect(() => parseUri('mysql://user:pass@/db')).toThrow();
  });

  it('should throw when username is missing', () => {
    expect(() => parseUri('mysql://localhost:3306/db')).toThrow('URI must include a username');
  });
});
