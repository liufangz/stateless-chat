import { randomUUID } from "node:crypto";
import type pg from "pg";
import { acquireFileLock, createPool, releaseFileLock, renewFileLock } from "@stateless-chat/shared";

// ---------------------------------------------------------------------------
// Cross-process coordination for the mutating file tools (write_file /
// edit_file), backed by the shared `file_locks` Postgres table
// (packages/shared/src/db.ts). Deliberately NOT a process-local in-memory
// Map: worker A and worker B are separate OS processes, each with its own
// heap, so any in-memory structure is invisible across them - see
// docs/FEATURE-multi-conversation-harness-analysis.md for why pi-source's
// own `withFileMutationQueue` (an in-memory Map) doesn't solve this.
//
// This module has two layers:
//   - `FileLock`: the three raw primitives (acquire/renew/release), backed
//     by createPostgresFileLock's real Postgres implementation. Tests can
//     substitute a fake implementing the same interface to exercise
//     write_file/edit_file's own logic without a database.
//   - `withFileLock`: the bounded-wait-with-backoff caller built on top,
//     used by write-file.ts/edit-file.ts to wrap their full
//     read/validate/modify/temp-write/rename sequence.
// ---------------------------------------------------------------------------

export interface FileLock {
  /** Attempts one acquisition; never waits. Returns whether it succeeded. */
  acquire(lockKey: string, ownerToken: string, leaseDurationMs: number): Promise<boolean>;
  /** Extends a currently-held lock's expiry. Returns false if no longer held. */
  renew(lockKey: string, ownerToken: string, leaseDurationMs: number): Promise<boolean>;
  /** Releases a currently-held lock. A no-op if not held (already expired/released). */
  release(lockKey: string, ownerToken: string): Promise<void>;
}

let defaultPool: pg.Pool | undefined;

/**
 * Lazily-created singleton pool shared by every default-constructed
 * write_file/edit_file tool instance (both call createPostgresFileLock()
 * with no pool at module-load time - see write-file.ts/edit-file.ts).
 * `createPool()` itself does not connect eagerly (node-postgres connects
 * lazily on first query), so constructing the default tools at import time
 * - which the existing DEFAULT_TOOLS singleton pattern already does - stays
 * side-effect-free until a tool call actually runs.
 */
function getDefaultLockPool(): pg.Pool {
  if (!defaultPool) defaultPool = createPool();
  return defaultPool;
}

export function createPostgresFileLock(pool?: pg.Pool): FileLock {
  const resolvedPool = pool ?? getDefaultLockPool();
  return {
    acquire: (lockKey, ownerToken, leaseDurationMs) =>
      acquireFileLock(resolvedPool, lockKey, ownerToken, leaseDurationMs),
    renew: (lockKey, ownerToken, leaseDurationMs) =>
      renewFileLock(resolvedPool, lockKey, ownerToken, leaseDurationMs),
    release: (lockKey, ownerToken) => releaseFileLock(resolvedPool, lockKey, ownerToken),
  };
}

// Long edits can renew the lease (brief requirement): the lease is renewed
// on a heartbeat well inside its own duration, mirroring the worker's
// existing message-lease heartbeat (env.leaseHeartbeatMs vs.
// env.leaseDurationMs in packages/worker/src/index.ts).
export const DEFAULT_LEASE_DURATION_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
// Bounded wait: the user's own A/B example describes a ~1-minute hold as the
// routine case, so this must comfortably outlast a normal edit without
// approaching the tool loop's own per-turn wall-clock budget (600s,
// packages/worker/src/tool-loop.ts). 20s is well under that, and short
// enough that a genuinely stuck holder doesn't stall the caller's turn.
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 20_000;
const INITIAL_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WithFileLockOptions {
  lock: FileLock;
  ownerToken?: string;
  leaseDurationMs?: number;
  acquireTimeoutMs?: number;
}

/**
 * Passed to `fn` so it can check, right before its actual mutating step
 * (the write/rename), whether this hold is still believed valid. This is a
 * best-effort, cooperative check - see `withFileLock`'s doc comment for why
 * it cannot be a hard guarantee.
 */
export interface FileLockContext {
  /** True once a renewal has explicitly been told this lock is no longer ours (reclaimed by another owner). */
  isLeaseLost(): boolean;
}

/**
 * Acquires `lockKey` (bounded wait with backoff, never an unbounded hang),
 * runs `fn` while holding it - renewing on a heartbeat so a long edit's
 * lease doesn't expire out from under it - then releases, in a `finally` so
 * a thrown error (e.g. edit_file's stale-content check) still frees the
 * lock. Callers must acquire this lock BEFORE reading the file and hold it
 * through the final rename, not just around the write - see edit-file.ts/
 * write-file.ts, which put their entire read/validate/modify/write sequence
 * inside `fn`.
 *
 * On timeout, throws a plain Error with a message aimed at the model (it
 * flows through executeToolCall's existing catch-all like any other tool
 * error), not a hang and not a silent overwrite.
 *
 * Lease loss mid-hold: a real filesystem write/rename cannot be fenced the
 * way a network storage write can (there is no token the OS checks before
 * letting the syscall land) - once `fn` has started its actual mutation,
 * this cannot un-happen it. What this DOES guarantee: (1) a renewal
 * heartbeat that is explicitly told `renewed === false` (another owner now
 * holds this lock - not merely a transient renewal error, which is
 * swallowed as noise) sets a flag `fn` can check via `ctx.isLeaseLost()`
 * before its own mutating step, so callers that check it there can abort
 * BEFORE writing in the common case where loss is detected first; and (2)
 * regardless of whether `fn` checked that flag, `withFileLock` itself never
 * reports success once lease loss was observed during the hold - it throws
 * instead of returning `fn`'s result, so a caller can never be told "this
 * succeeded cleanly" when another attempt may have raced it. This is the
 * honest guarantee available without pretending filesystem writes are
 * fenced: detect-and-refuse-to-claim-success, not prevent-the-write.
 */
export async function withFileLock<T>(
  lockKey: string,
  fn: (ctx: FileLockContext) => Promise<T>,
  options: WithFileLockOptions
): Promise<T> {
  const ownerToken = options.ownerToken ?? randomUUID();
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const deadline = Date.now() + acquireTimeoutMs;
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;

  for (;;) {
    const acquired = await options.lock.acquire(lockKey, ownerToken, leaseDurationMs);
    if (acquired) break;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Timed out after ${acquireTimeoutMs}ms waiting for a lock on '${lockKey}' - another edit is ` +
          "still in progress. This is a normal outcome under concurrent edits, not a failure of the " +
          "file itself; retrying the tool call may succeed shortly."
      );
    }
    await sleep(Math.min(retryDelayMs, remaining));
    retryDelayMs = Math.min(retryDelayMs * 1.5, MAX_RETRY_DELAY_MS);
  }

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    options.lock
      .renew(lockKey, ownerToken, leaseDurationMs)
      .then((renewed) => {
        // An explicit `false` means the lock is definitively no longer
        // ours - someone else's acquire() won it after our lease expired
        // (e.g. this process stalled past leaseDurationMs). A rejected
        // renew() call (network hiccup) is NOT the same signal - swallowed
        // below, same as before - a brief connectivity blip must not abort
        // an otherwise-healthy hold.
        if (!renewed) leaseLost = true;
      })
      .catch(() => {});
  }, Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(leaseDurationMs / 3)));

  try {
    const result = await fn({ isLeaseLost: () => leaseLost });
    if (leaseLost) {
      throw new Error(
        `Lock on '${lockKey}' was reclaimed by another owner while this operation was still running - ` +
          "its result cannot be trusted as a clean success (another attempt may have run concurrently " +
          "with part of it). Re-read the file and retry."
      );
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    // If we know the lease is already someone else's, releasing would be a
    // guaranteed no-op (owner_token no longer matches) - skip the round trip.
    if (!leaseLost) {
      await options.lock.release(lockKey, ownerToken).catch(() => {});
    }
  }
}

export { canonicalLockKey } from "./file-path-jail.js";
