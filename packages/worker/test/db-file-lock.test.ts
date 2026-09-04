// Cross-process file-lock regression tests, against real Postgres (the
// file_locks table in packages/shared/src/db.ts) - a mock can't meaningfully
// stand in for the atomic INSERT ... ON CONFLICT ... WHERE acquisition or
// concurrent-acquirer exclusion this depends on. Point DATABASE_URL at a
// disposable database, NEVER the production `chat` database:
//
//   DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test \
//     npx vitest run packages/worker/test/db-file-lock.test.ts
//
// This file TRUNCATEs the file_locks table in beforeAll - see
// test/support/require-test-database.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { env, createPool, initSchema, acquireFileLock, renewFileLock, releaseFileLock } from "@stateless-chat/shared";
import { requireDisposableTestDatabase } from "./support/require-test-database.js";

requireDisposableTestDatabase(env.databaseUrl);

const pool = createPool();

beforeAll(async () => {
  await initSchema(pool);
  await pool.query("TRUNCATE file_locks");
});

afterAll(async () => {
  await pool.end();
});

describe("file_locks: acquire / renew / release", () => {
  it("a fresh lock key is acquired immediately", async () => {
    const key = `/repo/${randomUUID()}.txt`;
    const acquired = await acquireFileLock(pool, key, "owner-a", 30_000);
    expect(acquired).toBe(true);
  });

  it("a second acquirer is refused while the lease is still live (no wait, no stealing)", async () => {
    const key = `/repo/${randomUUID()}.txt`;
    expect(await acquireFileLock(pool, key, "owner-a", 30_000)).toBe(true);
    expect(await acquireFileLock(pool, key, "owner-b", 30_000)).toBe(false);
  });

  it("a lock is reclaimable by a different owner once its lease has expired", async () => {
    const key = `/repo/${randomUUID()}.txt`;
    expect(await acquireFileLock(pool, key, "owner-a", 50)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await acquireFileLock(pool, key, "owner-b", 30_000)).toBe(true);

    // owner-a can no longer renew or release it - owner-b now owns it.
    expect(await renewFileLock(pool, key, "owner-a", 30_000)).toBe(false);
  });

  it("renewFileLock extends the lease only for the current owner", async () => {
    const key = `/repo/${randomUUID()}.txt`;
    await acquireFileLock(pool, key, "owner-a", 200);

    const before = (await pool.query<{ expires_at: string }>("SELECT expires_at FROM file_locks WHERE lock_key = $1", [key])).rows[0].expires_at;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(await renewFileLock(pool, key, "owner-b", 30_000)).toBe(false); // not the owner
    expect(await renewFileLock(pool, key, "owner-a", 30_000)).toBe(true);

    const after = (await pool.query<{ expires_at: string }>("SELECT expires_at FROM file_locks WHERE lock_key = $1", [key])).rows[0].expires_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("releaseFileLock only removes the lock for its own owner token (fencing)", async () => {
    const key = `/repo/${randomUUID()}.txt`;
    await acquireFileLock(pool, key, "owner-a", 30_000);

    await releaseFileLock(pool, key, "owner-b"); // wrong owner: no-op
    expect(await acquireFileLock(pool, key, "owner-c", 30_000)).toBe(false); // still held by owner-a

    await releaseFileLock(pool, key, "owner-a"); // correct owner
    expect(await acquireFileLock(pool, key, "owner-c", 30_000)).toBe(true); // now free
  });

  it("release is a harmless no-op when the lock was never held, or already released", async () => {
    const key = `/repo/${randomUUID()}.txt`;
    await expect(releaseFileLock(pool, key, "owner-a")).resolves.toBeUndefined();

    await acquireFileLock(pool, key, "owner-a", 30_000);
    await releaseFileLock(pool, key, "owner-a");
    await expect(releaseFileLock(pool, key, "owner-a")).resolves.toBeUndefined();
  });

  it("two concurrent acquirers for the same key: exactly one succeeds", async () => {
    const key = `/repo/${randomUUID()}.txt`;
    const [a, b] = await Promise.all([
      acquireFileLock(pool, key, "owner-a", 30_000),
      acquireFileLock(pool, key, "owner-b", 30_000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("different keys never contend with each other", async () => {
    const keyA = `/repo/${randomUUID()}.txt`;
    const keyB = `/repo/${randomUUID()}.txt`;
    expect(await acquireFileLock(pool, keyA, "owner-a", 30_000)).toBe(true);
    expect(await acquireFileLock(pool, keyB, "owner-b", 30_000)).toBe(true);
  });
});
