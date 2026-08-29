// Single source of truth for the disposable-database guard used by every
// Postgres-backed test file (db-lease.test.ts, turn-recovery.test.ts,
// crash-recovery.e2e.test.ts). Each of those TRUNCATEs shared tables in
// beforeAll, and DATABASE_URL defaults (packages/shared/src/env.ts) to the
// local dev `chat` database when unset - not production, but real data a
// test run must never be able to silently wipe. Call this before creating a
// pool or touching the database at all; a duplicated inline copy of this
// check in each file is exactly how one file (db-lease.test.ts) previously
// shipped without it and truncated a real database.
export function requireDisposableTestDatabase(databaseUrl: string): void {
  if (!/\/\w*test\w*(\?|$)/i.test(databaseUrl)) {
    throw new Error(
      `Refusing to run: DATABASE_URL ('${databaseUrl}') does not look like a disposable test ` +
        "database (expected the database name to contain 'test', e.g. chat_test). Set " +
        "DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test before running this file."
    );
  }
}
