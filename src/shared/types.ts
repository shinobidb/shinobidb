export type DatabaseType = 'mysql';

export interface DatabaseConnectionConfig {
  type: DatabaseType;
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  ssl?: boolean;
}
