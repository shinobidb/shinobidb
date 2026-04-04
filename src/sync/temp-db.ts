/**
 * Generate a unique temporary database name.
 * Uses `_shinobi_` prefix to identify shinobidb-created temp databases
 * (avoids collision with user-created `_temp` databases).
 */
export function generateTempDbName(targetDb: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  return `${targetDb}_shinobi_${timestamp}`;
}

/**
 * Generate the "old" database name used during swap.
 */
export function generateOldDbName(targetDb: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  return `${targetDb}_shinobi_old_${timestamp}`;
}

/**
 * Check if a database name looks like a shinobidb temp/old database.
 */
export function isShinobiTempDb(dbName: string): boolean {
  return /_shinobi_(old_)?\d+$/.test(dbName);
}
