// Phase 1 reliability regression tests: durable processing lease claim /
// reclaim, concurrent-claim exclusion, heartbeat/expiry, failure
// persistence, and recovery after a simulated worker crash.
//
// These exercise real Postgres (FOR UPDATE SKIP LOCKED + lease-expiry SQL
// in packages/shared/src/db.ts) - a mock can't meaningfully stand in for
// that concurrency behavior. Point DATABASE_URL at a disposable database,
// NEVER the production `chat` database:
//
//   DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test \
//     npx vitest run packages/worker/test/db-lease.test.ts
//
// (see repo root: `docker exec stateless-chat-postgres psql -U chat -d chat
// -c "CREATE DATABASE chat_test;"` to create it once.)
//
// This file TRUNCATEs shared tables in beforeAll, so it refuses to run
// against anything but an obviously-disposable database - see
// test/support/require-test-database.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  env,
  createPool,
  initSchema,
  createConversation,
  insertUserMessage,
  claimPendingMessages,
  sweepExhaustedLeases,
  renewLease,
  stillOwnsLease,
  markMessageDone,
  markMessageFailed,
  requeueMessageForRetry,
  getMessage,
  getConversationHistory,
  insertToolCallRequest,
  insertToolResult,
} from "@stateless-chat/shared";
import { requireDisposableTestDatabase } from "./support/require-test-database.js";

requireDisposableTestDatabase(env.databaseUrl);

const pool = createPool();

async function freshConversation(): Promise<string> {
  const conv = await createConversation(pool, "test-client");
  return conv.id;
}

beforeAll(async () => {
  await initSchema(pool);
  // Start from a clean slate so assertions about exactly which rows get
  // claimed aren't affected by rows left over from a previous run against
  // this same disposable database.
  await pool.query("TRUNCATE messages, conversations RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

describe("claim / reclaim lease semantics", () => {
  it("claims a pending message and sets owner + lease + attempt_count", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");

    const claimed = await claimPendingMessages(pool, "worker-a", 30_000, 5);
    const mine = claimed.find((m) => m.id === msg.id);

    expect(mine).toBeDefined();
    expect(mine!.status).toBe("processing");
    expect(mine!.worker_id).toBe("worker-a");
    expect(mine!.attempt_count).toBe(1);
    expect(mine!.lease_expires_at).not.toBeNull();
  });

  it("does not reclaim a row whose lease is still live", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "worker-a", 30_000, 5);

    const secondClaim = await claimPendingMessages(pool, "worker-b", 30_000, 5);
    expect(secondClaim.find((m) => m.id === msg.id)).toBeUndefined();

    const row = await getMessage(pool, msg.id);
    expect(row!.worker_id).toBe("worker-a");
    expect(row!.status).toBe("processing");
  });

  it("reclaims a row once its lease has expired, incrementing attempt_count", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "worker-a", 50, 5); // 50ms lease

    await new Promise((resolve) => setTimeout(resolve, 150));

    const reclaimed = await claimPendingMessages(pool, "worker-b", 30_000, 5);
    const mine = reclaimed.find((m) => m.id === msg.id);
    expect(mine).toBeDefined();
    expect(mine!.worker_id).toBe("worker-b");
    expect(mine!.attempt_count).toBe(2);
  });

  it("reclaims a legacy processing row that has no lease columns yet", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "legacy");
    await pool.query(
      `UPDATE messages
       SET status = 'processing', worker_id = NULL, lease_expires_at = NULL
       WHERE id = $1`,
      [msg.id]
    );

    const reclaimed = await claimPendingMessages(pool, "worker-b", 30_000, 5);
    const mine = reclaimed.find((m) => m.id === msg.id);
    expect(mine).toBeDefined();
    expect(mine!.worker_id).toBe("worker-b");
    expect(mine!.attempt_count).toBe(1);
  });

  it("two concurrent claimers never both get the same row (SKIP LOCKED exclusion)", async () => {
    const conversationId = await freshConversation();
    const msgs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => insertUserMessage(pool, conversationId, `msg ${i}`))
    );

    const [a, b] = await Promise.all([
      claimPendingMessages(pool, "worker-a", 30_000, 10),
      claimPendingMessages(pool, "worker-b", 30_000, 10),
    ]);

    const aIds = new Set(a.map((m) => m.id));
    const bIds = new Set(b.map((m) => m.id));
    const overlap = [...aIds].filter((id) => bIds.has(id));
    expect(overlap).toHaveLength(0);

    for (const msg of msgs) {
      expect(aIds.has(msg.id) || bIds.has(msg.id)).toBe(true);
    }
  });
});

describe("heartbeat / lease renewal", () => {
  it("renewLease extends the lease for the current owner", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "worker-a", 200, 5);

    const before = (await getMessage(pool, msg.id))!.lease_expires_at!;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const renewed = await renewLease(pool, msg.id, "worker-a", 10_000);
    expect(renewed).toBe(true);

    const after = (await getMessage(pool, msg.id))!.lease_expires_at!;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("renewLease fails once another worker has reclaimed the row", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "worker-a", 50, 5);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await claimPendingMessages(pool, "worker-b", 30_000, 5); // reclaims from worker-a

    const renewed = await renewLease(pool, msg.id, "worker-a", 30_000);
    expect(renewed).toBe(false);

    expect(await stillOwnsLease(pool, msg.id, "worker-a")).toBe(false);
    expect(await stillOwnsLease(pool, msg.id, "worker-b")).toBe(true);
  });
});

describe("failure persistence", () => {
  it("markMessageFailed stores a diagnosable last_error and clears the lease", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "worker-a", 30_000, 5);

    await markMessageFailed(pool, msg.id, "OpenAI request failed: 500 Internal Server Error");

    const row = await getMessage(pool, msg.id);
    expect(row!.status).toBe("failed");
    expect(row!.last_error).toContain("500 Internal Server Error");
    expect(row!.lease_expires_at).toBeNull();
  });

  it("truncates pathologically long error text instead of storing it unbounded", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "worker-a", 30_000, 5);

    await markMessageFailed(pool, msg.id, "x".repeat(10_000));
    const row = await getMessage(pool, msg.id);
    expect(row!.last_error!.length).toBeLessThanOrEqual(2000);
  });
});

describe("recovery after a simulated worker interruption", () => {
  it("a crashed worker's row becomes reclaimable without operator action, and eventually completes", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");

    // Worker A claims it, then "crashes" - never renews, never finishes.
    await claimPendingMessages(pool, "crashed-worker", 50, 5);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Worker B's poll loop: sweep (no-op here, attempt_count is still low),
    // then claim - it should pick up the abandoned row on its own, with no
    // operator intervention and no bulk requeue-everything-at-startup.
    await sweepExhaustedLeases(pool, 3);
    const reclaimed = await claimPendingMessages(pool, "worker-b", 30_000, 5);
    const mine = reclaimed.find((m) => m.id === msg.id);
    expect(mine).toBeDefined();
    expect(mine!.worker_id).toBe("worker-b");

    // Worker B finishes normally.
    await markMessageDone(pool, msg.id);
    const row = await getMessage(pool, msg.id);
    expect(row!.status).toBe("done");
    expect(row!.lease_expires_at).toBeNull();
  });

  it("gives up after maxAttempts repeated lease expiries instead of reclaiming forever", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");

    // Simulate 3 crash cycles: claim with a short lease, let it expire, repeat.
    for (let i = 0; i < 3; i++) {
      await claimPendingMessages(pool, `crashed-worker-${i}`, 30, 5);
      await new Promise((resolve) => setTimeout(resolve, 90));
    }

    const swept = await sweepExhaustedLeases(pool, 3);
    expect(swept).toBeGreaterThanOrEqual(1);

    const row = await getMessage(pool, msg.id);
    expect(row!.status).toBe("failed");
    expect(row!.last_error).toContain("gave up after");

    // And it's no longer claimable - it won't loop forever.
    const claimed = await claimPendingMessages(pool, "worker-x", 30_000, 5);
    expect(claimed.find((m) => m.id === msg.id)).toBeUndefined();
  });

  it("operator recovery requeues a failed row but refuses a row under a live lease", async () => {
    const conversationId = await freshConversation();
    const failedMsg = await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "worker-a", 30_000, 5);
    await markMessageFailed(pool, failedMsg.id, "boom");

    const requeued = await requeueMessageForRetry(pool, failedMsg.id);
    expect(requeued).toBe(true);
    const row = await getMessage(pool, failedMsg.id);
    expect(row!.status).toBe("pending");
    expect(row!.worker_id).toBeNull();

    // A row a worker actively holds a live (non-expired) lease on must not
    // be touched - this is what makes the recovery path safe to run
    // without risking duplicate execution.
    const liveConversationId = await freshConversation();
    const liveMsg = await insertUserMessage(pool, liveConversationId, "hi2");
    await claimPendingMessages(pool, "worker-a", 30_000, 5);
    const blocked = await requeueMessageForRetry(pool, liveMsg.id);
    expect(blocked).toBe(false);
    const liveRow = await getMessage(pool, liveMsg.id);
    expect(liveRow!.status).toBe("processing");
  });
});

describe("conversation history ordering", () => {
  it("keeps each assistant tool-call row adjacent to its tool result rows", async () => {
    const conversationId = await freshConversation();
    const first = await insertUserMessage(pool, conversationId, "first");
    const second = await insertUserMessage(pool, conversationId, "second");

    await insertToolCallRequest(pool, conversationId, first.id, 0, [
      { toolCallId: "call-first", toolName: "calculator", arguments: "{}" },
    ]);
    await insertToolCallRequest(pool, conversationId, second.id, 0, [
      { toolCallId: "call-second", toolName: "calculator", arguments: "{}" },
    ]);
    await insertToolResult(pool, conversationId, first.id, {
      toolCallId: "call-first",
      toolName: "calculator",
      result: "1",
      isError: false,
    });
    await insertToolResult(pool, conversationId, second.id, {
      toolCallId: "call-second",
      toolName: "calculator",
      result: "2",
      isError: false,
    });

    const history = await getConversationHistory(pool, conversationId);
    expect(history.map((row) => row.id)).toEqual([
      first.id,
      expect.any(String),
      expect.any(String),
      second.id,
      expect.any(String),
      expect.any(String),
    ]);
    expect(history.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
    ]);
    expect(history[2].tool_call_id).toBe("call-first");
    expect(history[5].tool_call_id).toBe("call-second");
  });
});
