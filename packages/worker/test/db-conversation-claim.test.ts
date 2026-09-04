// Regression tests for the conversation-level claim exclusion added to
// claimPendingMessages (packages/shared/src/db.ts): different conversations
// must still claim fully in parallel, but two pending rows in the SAME
// conversation must never both be 'processing' at once, even when claimed by
// two concurrent callers (simulating two separate worker processes). Against
// real Postgres - the whole point is the pg_try_advisory_xact_lock + row-lock
// interaction, which a mock can't exercise meaningfully.
//
//   DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test \
//     npx vitest run packages/worker/test/db-conversation-claim.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  env,
  createPool,
  initSchema,
  createConversation,
  insertUserMessage,
  claimPendingMessages,
  getMessage,
  markMessageDone,
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
});

// claimPendingMessages scans the whole `messages` table, not one
// conversation - several assertions below check exact claimed-row counts,
// which an unresolved leftover 'pending'/'processing' row from an EARLIER
// test in this file (a different, older, still-eligible candidate) can
// silently perturb (see the "two concurrent claimers" and "different
// conversations" tests' comments for the specific failure shapes this
// caused before this was a beforeEach). Truncate before every test, not
// just once, so each test's claim assertions are against a clean slate.
beforeEach(async () => {
  await pool.query("TRUNCATE messages, conversations RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

describe("conversation-level claim exclusion", () => {
  it("does not claim a second pending row while the conversation already has one genuinely processing", async () => {
    const conversationId = await freshConversation();
    const first = await insertUserMessage(pool, conversationId, "first");
    const second = await insertUserMessage(pool, conversationId, "second");

    const firstClaim = await claimPendingMessages(pool, "worker-a", 30_000, 1);
    expect(firstClaim.map((m) => m.id)).toEqual([first.id]);

    // Second message is still 'pending', but its conversation already has a
    // live-processing row - must not be claimed yet.
    const secondClaim = await claimPendingMessages(pool, "worker-b", 30_000, 1);
    expect(secondClaim.find((m) => m.id === second.id)).toBeUndefined();

    const row = await getMessage(pool, second.id);
    expect(row!.status).toBe("pending");
  });

  it("claims the second row once the first turn completes", async () => {
    const conversationId = await freshConversation();
    const first = await insertUserMessage(pool, conversationId, "first");
    const second = await insertUserMessage(pool, conversationId, "second");

    await claimPendingMessages(pool, "worker-a", 30_000, 1);
    await markMessageDone(pool, first.id);

    const claim = await claimPendingMessages(pool, "worker-b", 30_000, 1);
    expect(claim.map((m) => m.id)).toEqual([second.id]);
  });

  it("two concurrent claimers racing on two pending rows of the SAME conversation: only one ever becomes processing", async () => {
    const conversationId = await freshConversation();
    await insertUserMessage(pool, conversationId, "first");
    await insertUserMessage(pool, conversationId, "second");

    await Promise.all([
      claimPendingMessages(pool, "worker-a", 30_000, 1),
      claimPendingMessages(pool, "worker-b", 30_000, 1),
    ]);

    // Assert scoped to THIS conversation via a direct DB query, not by
    // combining the two calls' own returned rows - claimPendingMessages
    // scans the whole `messages` table, not one conversation, so with
    // limit=1 either concurrent caller can legitimately pick up a
    // DIFFERENT, unrelated eligible row (e.g. left over from an earlier
    // test in this file) instead of contesting this conversation's two
    // rows. The guarantee under test is "this conversation never has two
    // rows processing at once" - not "the two calls necessarily raced
    // each other" - so check the conversation's own state directly.
    const processingCount = (
      await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1 AND status = 'processing'`,
        [conversationId]
      )
    ).rows[0].count;
    expect(processingCount).toBe("1");
  });

  it("a conversation whose only processing row's lease has expired is still reclaimable (crash recovery unaffected)", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "crashed-worker", 50, 1); // 50ms lease
    await new Promise((resolve) => setTimeout(resolve, 150));

    const reclaimed = await claimPendingMessages(pool, "worker-b", 30_000, 1);
    expect(reclaimed.map((m) => m.id)).toEqual([msg.id]);
    expect(reclaimed[0].worker_id).toBe("worker-b");
  });

  it("different conversations still claim fully in parallel (cross-conversation throughput unaffected)", async () => {
    const conversationIds = await Promise.all(
      Array.from({ length: 5 }, () => freshConversation())
    );
    const messages = await Promise.all(
      conversationIds.map((id) => insertUserMessage(pool, id, "hi"))
    );

    const [a, b] = await Promise.all([
      claimPendingMessages(pool, "worker-a", 30_000, 5),
      claimPendingMessages(pool, "worker-b", 30_000, 5),
    ]);

    // Filtered to this test's own message ids before checking set size:
    // with limit=5 and ORDER BY created_at ASC, an older leftover 'pending'
    // row from an earlier test in this file (a different, unrelated
    // conversation) can legitimately also be claimed by one of these two
    // calls, since it's simply an eligible row that happens to be older -
    // that's correct claim behavior, not something this test should fail
    // on. What actually matters here is unaffected by that noise: every
    // one of THIS test's 5 messages got claimed by someone, exactly once.
    const relevantIds = new Set(messages.map((m) => m.id));
    const claimedIds = new Set(
      [...a, ...b].map((m) => m.id).filter((id) => relevantIds.has(id))
    );
    for (const msg of messages) {
      expect(claimedIds.has(msg.id)).toBe(true);
    }
    expect(claimedIds.size).toBe(messages.length);
  });
});
