// Regression tests for deleteConversation's in-flight-turn guard
// (packages/shared/src/db.ts) - a conversation with a genuinely-processing
// turn (a live-leased 'processing' user row) must not be deleted out from
// under the worker holding an in-memory reference to it, which would make
// its later persistence INSERTs violate their foreign keys. Against real
// Postgres, since the guarantee depends on real row-locking (FOR UPDATE)
// interacting correctly with claimPendingMessages's own FOR UPDATE SKIP
// LOCKED - a mock can't exercise that.
//
//   DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test \
//     npx vitest run packages/worker/test/db-delete-conversation.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  env,
  createPool,
  initSchema,
  createConversation,
  insertUserMessage,
  claimPendingMessages,
  markMessageDone,
  deleteConversation,
  getConversation,
  getMessage,
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
  await pool.query("TRUNCATE messages, conversations RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

describe("deleteConversation: in-flight-turn guard", () => {
  it("deletes a conversation with no messages", async () => {
    const conversationId = await freshConversation();
    expect(await deleteConversation(pool, conversationId)).toBe("deleted");
    expect(await getConversation(pool, conversationId)).toBeNull();
  });

  it("deletes a conversation whose turns are all done", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "worker-a", 30_000, 1);
    await markMessageDone(pool, msg.id);

    expect(await deleteConversation(pool, conversationId)).toBe("deleted");
    expect(await getConversation(pool, conversationId)).toBeNull();
  });

  it("deletes a conversation with only an untouched 'pending' row (no worker holds a reference to it yet)", async () => {
    const conversationId = await freshConversation();
    await insertUserMessage(pool, conversationId, "hi");

    expect(await deleteConversation(pool, conversationId)).toBe("deleted");
  });

  it("refuses to delete a conversation with a genuinely-processing turn (live lease) - returns 'in_progress', touches nothing", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "worker-a", 30_000, 1); // live lease

    expect(await deleteConversation(pool, conversationId)).toBe("in_progress");

    // Nothing was touched - the conversation and its processing row survive
    // exactly as a worker mid-turn would expect to find them.
    expect(await getConversation(pool, conversationId)).not.toBeNull();
    const row = await getMessage(pool, msg.id);
    expect(row!.status).toBe("processing");
  });

  it("deletes a conversation whose 'processing' row's lease has EXPIRED (an abandoned/crashed turn - no worker holds a live reference)", async () => {
    const conversationId = await freshConversation();
    await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "crashed-worker", 50, 1); // 50ms lease
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await deleteConversation(pool, conversationId)).toBe("deleted");
  });

  it("returns 'not_found' for a nonexistent conversation, and is scoped by clientId when provided", async () => {
    expect(await deleteConversation(pool, "00000000-0000-0000-0000-000000000000")).toBe("not_found");

    const conversationId = await freshConversation(); // owned by "test-client"
    expect(await deleteConversation(pool, conversationId, "someone-else")).toBe("not_found");
    expect(await getConversation(pool, conversationId)).not.toBeNull(); // untouched
    expect(await deleteConversation(pool, conversationId, "test-client")).toBe("deleted");
  });

  it("a delete blocked by an in-flight turn does not prevent that turn from completing normally afterward", async () => {
    const conversationId = await freshConversation();
    const msg = await insertUserMessage(pool, conversationId, "hi");
    await claimPendingMessages(pool, "worker-a", 30_000, 1);

    expect(await deleteConversation(pool, conversationId)).toBe("in_progress");

    // The worker finishes its turn exactly as if the delete attempt never
    // happened - deterministic, no dangling transaction/lock left behind
    // by the refused delete.
    await markMessageDone(pool, msg.id);
    const row = await getMessage(pool, msg.id);
    expect(row!.status).toBe("done");

    // Now that the turn is done, deletion succeeds.
    expect(await deleteConversation(pool, conversationId)).toBe("deleted");
  });

  it("does not block a claimPendingMessages call for an UNRELATED conversation while holding this one's row lock", async () => {
    const blockedConversationId = await freshConversation();
    await insertUserMessage(pool, blockedConversationId, "hi");
    await claimPendingMessages(pool, "worker-a", 30_000, 1);

    const otherConversationId = await freshConversation();
    await insertUserMessage(pool, otherConversationId, "unrelated");

    const [deleteOutcome, claimed] = await Promise.all([
      deleteConversation(pool, blockedConversationId),
      claimPendingMessages(pool, "worker-b", 30_000, 1),
    ]);

    expect(deleteOutcome).toBe("in_progress");
    expect(claimed.map((m) => m.conversation_id)).toContain(otherConversationId);
  });
});
