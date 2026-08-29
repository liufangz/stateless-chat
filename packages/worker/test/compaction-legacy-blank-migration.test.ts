// Regression test for the corrective fix to Phase 4's compactions_summary_not_blank
// constraint: a production database can already contain a legacy compaction row
// with an empty/whitespace summary (predating the constraint, or restored from a
// backup taken before it existed). A plain `ADD CONSTRAINT ... CHECK (...)`
// validates every existing row as part of the ALTER, so it would fail forever on
// such a database - initSchema() (and therefore every worker/gateway boot) would
// never succeed again. The fix adds the constraint NOT VALID (see
// packages/shared/src/db.ts), which still rejects every new violating
// INSERT/UPDATE but does not scan/validate rows that predate it.
//
// This file proves, against a disposable database seeded with exactly that kind
// of legacy row:
//   1. initSchema() succeeds (does not throw) with the legacy blank row present.
//   2. The legacy row is preserved untouched (not deleted/rewritten).
//   3. getLatestCompaction/getCompactionsForConversation exclude it as unusable.
//   4. The constraint still rejects a *new* direct blank-summary insert.
//   5. A valid compaction still persists and becomes the usable latest/listed one.
//
// Exercises real Postgres - point DATABASE_URL at a disposable database, NEVER
// the production `chat` database:
//
//   DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test \
//     npx vitest run packages/worker/test/compaction-legacy-blank-migration.test.ts
//
// This file TRUNCATEs/ALTERs shared tables, so it refuses to run against
// anything but an obviously-disposable database - see
// test/support/require-test-database.ts.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  env,
  createPool,
  initSchema,
  createConversation,
  insertUserMessage,
  insertCompaction,
  getLatestCompaction,
  getCompactionsForConversation,
} from "@stateless-chat/shared";
import { requireDisposableTestDatabase } from "./support/require-test-database.js";

requireDisposableTestDatabase(env.databaseUrl);

const pool = createPool();

beforeAll(async () => {
  await initSchema(pool);
  await pool.query("TRUNCATE messages, conversations, compactions RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

async function freshConversation(): Promise<string> {
  const conv = await createConversation(pool, "test-client");
  return conv.id;
}

/**
 * Seeds a legacy blank-summary compaction row the way it could really have
 * arrived: with the not-blank constraint absent (as if this row predates
 * Phase 4's constraint entirely), inserted directly via SQL - never through
 * insertCompaction, which independently refuses blank summaries in
 * application code and would never let this row exist in the first place.
 */
async function seedLegacyBlankRow(conversationId: string, userMessageId: string): Promise<string> {
  await pool.query("ALTER TABLE compactions DROP CONSTRAINT IF EXISTS compactions_summary_not_blank");
  const id = randomUUID();
  await pool.query(
    `INSERT INTO compactions
       (id, conversation_id, summary, first_kept_message_id, source_start_message_id,
        triggered_by_message_id, tokens_before, prompt_tokens, completion_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, conversationId, "", userMessageId, userMessageId, userMessageId, 100, 10, 5]
  );
  return id;
}

describe("legacy blank compaction row: additive migration safety", () => {
  it("initSchema succeeds (does not throw) when a legacy blank-summary row already exists", async () => {
    const conversationId = await freshConversation();
    const userMsg = await insertUserMessage(pool, conversationId, "hi");
    const legacyId = await seedLegacyBlankRow(conversationId, userMsg.id);

    // This is the exact call every worker/gateway makes on startup. With a
    // validated (non-NOT-VALID) CHECK constraint, re-adding it here over a
    // table that already contains `legacyId`'s blank row would throw and
    // never let the process start.
    await expect(initSchema(pool)).resolves.not.toThrow();

    // The legacy row must still physically exist, untouched - the fix must
    // not delete or rewrite it.
    const { rows } = await pool.query("SELECT id, summary FROM compactions WHERE id = $1", [legacyId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe("");
  });

  it("a legacy blank row is not returned as a usable latest compaction", async () => {
    const conversationId = await freshConversation();
    const userMsg = await insertUserMessage(pool, conversationId, "hi");
    await seedLegacyBlankRow(conversationId, userMsg.id);
    await initSchema(pool);

    expect(await getLatestCompaction(pool, conversationId)).toBeNull();
    expect(await getCompactionsForConversation(pool, conversationId)).toEqual([]);
  });

  it("a legacy blank row is excluded from listings even alongside a valid compaction", async () => {
    const conversationId = await freshConversation();
    const userMsg1 = await insertUserMessage(pool, conversationId, "first");
    await seedLegacyBlankRow(conversationId, userMsg1.id);
    await initSchema(pool);

    const userMsg2 = await insertUserMessage(pool, conversationId, "second");
    const valid = await insertCompaction(pool, {
      id: randomUUID(),
      conversationId,
      triggeredByMessageId: userMsg2.id,
      summary: "a real, usable summary",
      firstKeptMessageId: userMsg2.id,
      sourceStartMessageId: userMsg1.id,
      tokensBefore: 500,
      promptTokens: 50,
      completionTokens: 20,
    });

    const latest = await getLatestCompaction(pool, conversationId);
    expect(latest?.id).toBe(valid.id);
    expect(latest?.summary).toBe("a real, usable summary");

    const all = await getCompactionsForConversation(pool, conversationId);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(valid.id);
  });

  it("still rejects a brand-new blank-summary insert once the NOT VALID constraint is (re-)applied", async () => {
    const conversationId = await freshConversation();
    const userMsg = await insertUserMessage(pool, conversationId, "hi");
    await seedLegacyBlankRow(conversationId, userMsg.id);
    await initSchema(pool); // re-applies compactions_summary_not_blank NOT VALID

    const newUserMsg = await insertUserMessage(pool, conversationId, "second turn");

    // insertCompaction's own application-level guard.
    await expect(
      insertCompaction(pool, {
        id: randomUUID(),
        conversationId,
        triggeredByMessageId: newUserMsg.id,
        summary: "   ",
        firstKeptMessageId: newUserMsg.id,
        sourceStartMessageId: userMsg.id,
        tokensBefore: 100,
        promptTokens: 10,
        completionTokens: 5,
      })
    ).rejects.toThrow(/empty\/whitespace-only summary/);

    // The DB-level constraint independently rejects it too, bypassing the
    // application guard entirely - proves NOT VALID still enforces on new
    // rows, it only skipped validating rows that predate it. Uses
    // spaces-only (not e.g. "\n") because Postgres's single-arg btrim()
    // only strips spaces, matching the existing DB-level test in
    // compaction-persistence.test.ts - a pre-existing property of the
    // constraint's definition, not something this fix changes.
    await expect(
      pool.query(
        `INSERT INTO compactions
           (id, conversation_id, summary, first_kept_message_id, source_start_message_id,
            triggered_by_message_id, tokens_before, prompt_tokens, completion_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [randomUUID(), conversationId, "   ", newUserMsg.id, userMsg.id, newUserMsg.id, 100, 10, 5]
      )
    ).rejects.toThrow();
  });

  it("a valid compaction still persists and is returned normally after the legacy row is present", async () => {
    const conversationId = await freshConversation();
    const userMsg = await insertUserMessage(pool, conversationId, "hi");
    await seedLegacyBlankRow(conversationId, userMsg.id);
    await initSchema(pool);

    const newUserMsg = await insertUserMessage(pool, conversationId, "second turn");
    const committed = await insertCompaction(pool, {
      id: randomUUID(),
      conversationId,
      triggeredByMessageId: newUserMsg.id,
      summary: "everything is fine",
      firstKeptMessageId: newUserMsg.id,
      sourceStartMessageId: userMsg.id,
      tokensBefore: 321,
      promptTokens: 30,
      completionTokens: 12,
    });

    expect(committed.summary).toBe("everything is fine");
    const latest = await getLatestCompaction(pool, conversationId);
    expect(latest?.id).toBe(committed.id);
  });
});
