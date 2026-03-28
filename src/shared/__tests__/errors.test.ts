import {
  ConfigFileError,
  ConfigValidationError,
  DatabaseConnectionError,
  DatabaseQueryError,
  MaskingError,
  ShinobiError,
  UnsupportedDatabaseError,
} from '../errors.js';

describe('ShinobiError', () => {
  it('should store message, code, and cause', () => {
    const cause = new Error('original');
    const err = new ShinobiError('test message', 'TEST_CODE', cause);

    expect(err.message).toBe('test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('ShinobiError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('DatabaseConnectionError', () => {
  it('should set correct code and name', () => {
    const err = new DatabaseConnectionError('connection failed');

    expect(err.code).toBe('DB_CONNECTION_ERROR');
    expect(err.name).toBe('DatabaseConnectionError');
    expect(err).toBeInstanceOf(ShinobiError);
  });
});

describe('DatabaseQueryError', () => {
  it('should set correct code and name', () => {
    const err = new DatabaseQueryError('query failed');

    expect(err.code).toBe('DB_QUERY_ERROR');
    expect(err.name).toBe('DatabaseQueryError');
    expect(err).toBeInstanceOf(ShinobiError);
  });
});

describe('ConfigValidationError', () => {
  it('should set correct code and name', () => {
    const err = new ConfigValidationError('invalid config');

    expect(err.code).toBe('CONFIG_VALIDATION_ERROR');
    expect(err.name).toBe('ConfigValidationError');
    expect(err).toBeInstanceOf(ShinobiError);
  });
});

describe('ConfigFileError', () => {
  it('should set correct code and name', () => {
    const err = new ConfigFileError('file not found');

    expect(err.code).toBe('CONFIG_FILE_ERROR');
    expect(err.name).toBe('ConfigFileError');
    expect(err).toBeInstanceOf(ShinobiError);
  });
});

describe('MaskingError', () => {
  it('should set correct code and name', () => {
    const err = new MaskingError('masking failed');

    expect(err.code).toBe('MASKING_ERROR');
    expect(err.name).toBe('MaskingError');
    expect(err).toBeInstanceOf(ShinobiError);
  });
});

describe('UnsupportedDatabaseError', () => {
  it('should include db type in message', () => {
    const err = new UnsupportedDatabaseError('mongodb');

    expect(err.message).toBe('Unsupported database type: mongodb');
    expect(err.code).toBe('UNSUPPORTED_DATABASE');
    expect(err.name).toBe('UnsupportedDatabaseError');
    expect(err).toBeInstanceOf(ShinobiError);
  });
});
