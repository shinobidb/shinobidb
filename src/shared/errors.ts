export class ShinobiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ShinobiError';
  }
}

export class DatabaseConnectionError extends ShinobiError {
  constructor(message: string, cause?: unknown) {
    super(message, 'DB_CONNECTION_ERROR', cause);
    this.name = 'DatabaseConnectionError';
  }
}

export class DatabaseQueryError extends ShinobiError {
  constructor(message: string, cause?: unknown) {
    super(message, 'DB_QUERY_ERROR', cause);
    this.name = 'DatabaseQueryError';
  }
}

export class ConfigValidationError extends ShinobiError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CONFIG_VALIDATION_ERROR', cause);
    this.name = 'ConfigValidationError';
  }
}

export class ConfigFileError extends ShinobiError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CONFIG_FILE_ERROR', cause);
    this.name = 'ConfigFileError';
  }
}

export class MaskingError extends ShinobiError {
  constructor(message: string, cause?: unknown) {
    super(message, 'MASKING_ERROR', cause);
    this.name = 'MaskingError';
  }
}

export class UnsupportedDatabaseError extends ShinobiError {
  constructor(dbType: string) {
    super(`Unsupported database type: ${dbType}`, 'UNSUPPORTED_DATABASE');
    this.name = 'UnsupportedDatabaseError';
  }
}
