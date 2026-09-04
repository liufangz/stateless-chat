import type { FileLock } from "../../src/tools/file-lock.js";

// Test-only in-memory FileLock, deliberately NOT exported from src/ or used
// by any default tool wiring - production write_file/edit_file always
// default to createPostgresFileLock (see file-lock.ts's module comment for
// why an in-memory Map can't stand in for a cross-process lock). This exists
// so write-file-tool.test.ts/edit-file-tool.test.ts can exercise the tools'
// own read/validate/write logic (path jail, expected_hash precondition,
// old_string staleness) as fast unit tests without a real Postgres
// connection - the actual cross-process locking behavior is covered
// separately against real Postgres in file-lock.test.ts /
// file-lock-cross-process.test.ts.
export function createFakeFileLock(): FileLock & { acquireCallCount: number } {
  const held = new Map<string, string>();
  const lock = {
    acquireCallCount: 0,
    async acquire(lockKey: string, ownerToken: string): Promise<boolean> {
      lock.acquireCallCount++;
      if (held.has(lockKey)) return false;
      held.set(lockKey, ownerToken);
      return true;
    },
    async renew(lockKey: string, ownerToken: string): Promise<boolean> {
      return held.get(lockKey) === ownerToken;
    },
    async release(lockKey: string, ownerToken: string): Promise<void> {
      if (held.get(lockKey) === ownerToken) held.delete(lockKey);
    },
  };
  return lock;
}

/** A lock whose acquire() always reports "already held" - for testing the timeout path. */
export function createAlwaysHeldFileLock(): FileLock {
  return {
    async acquire(): Promise<boolean> {
      return false;
    },
    async renew(): Promise<boolean> {
      return false;
    },
    async release(): Promise<void> {},
  };
}
