// Re-verifies the conversation-ordering claim guard (db-conversation-claim.test.ts's
// concern) against genuinely separate OS processes, not `Promise.all`
// within one process/one pg.Pool - the post-implementation audit explicitly
// asked to recheck this for real separate processes, including the exact
// limit=1 path the real worker always uses
// (packages/worker/src/index.ts's claimAndProcess). Two real `tsx` child
// processes, sharing only Postgres, race to claim from the same
// conversation.
//
//   DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test \
//     npx vitest run packages/worker/test/db-conversation-claim-cross-process.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  env,
  createPool,
  initSchema,
  createConversation,
  insertUserMessage,
  getMessage,
} from "@stateless-chat/shared";
import { requireDisposableTestDatabase } from "./support/require-test-database.js";

requireDisposableTestDatabase(env.databaseUrl);

const pool = createPool();
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cliScript = path.join(here, "support", "claim-cli.ts");

beforeAll(async () => {
  await initSchema(pool);
}, 30_000);

// claim-cli.ts's claimPendingMessages call scans the whole `messages` table,
// not one conversation - an unresolved leftover 'pending' row from an
// EARLIER test in this file (a different, older, still-eligible candidate)
// can be legitimately picked up by a later test's own claim calls,
// perturbing exact-claimed-count assertions (this is exactly what caused
// the intermittent, non-flaky-by-luck failure this file's "repeated races"
// test originally had - see its comment). Truncate before every test.
beforeEach(async () => {
  await pool.query("TRUNCATE messages, conversations RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

interface ClaimResult {
  claimedIds: string[];
}

function runClaimCli(workerId: string): Promise<ClaimResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliScript, workerId], {
      env: { ...process.env, DATABASE_URL: env.databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", () => {
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        reject(new Error(`claim-cli produced no output. stderr: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`claim-cli produced non-JSON output: ${line}\nstderr: ${stderr}`));
      }
    });
  });
}

async function freshConversation(): Promise<string> {
  const conv = await createConversation(pool, "cross-process-test-client");
  return conv.id;
}

describe("cross-process conversation-ordering claim guard: two real Node processes", () => {
  it(
    "two pending rows in the SAME conversation, claimed by two real processes at once (limit=1 each, matching the real worker path): exactly one is ever claimed",
    async () => {
      const conversationId = await freshConversation();
      const first = await insertUserMessage(pool, conversationId, "first");
      const second = await insertUserMessage(pool, conversationId, "second");

      const [a, b] = await Promise.all([runClaimCli("worker-a"), runClaimCli("worker-b")]);

      const claimedIds = [...a.claimedIds, ...b.claimedIds];
      expect(claimedIds).toHaveLength(1);
      expect([first.id, second.id]).toContain(claimedIds[0]);

      const processingCount = (
        await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1 AND status = 'processing'`,
          [conversationId]
        )
      ).rows[0].count;
      expect(processingCount).toBe("1");

      // The other row is untouched, still pending - available to be claimed
      // once the first turn finishes, exactly as the real worker's poll
      // loop would pick it up.
      const untouchedId = claimedIds[0] === first.id ? second.id : first.id;
      const untouchedRow = await getMessage(pool, untouchedId);
      expect(untouchedRow!.status).toBe("pending");
    },
    20_000
  );

  it(
    "different conversations still claim fully in parallel across real processes - the guard is conversation-scoped, not global",
    async () => {
      const conversationIds = await Promise.all([freshConversation(), freshConversation()]);
      const messages = await Promise.all(
        conversationIds.map((id) => insertUserMessage(pool, id, "hi"))
      );

      const [a, b] = await Promise.all([runClaimCli("worker-a"), runClaimCli("worker-b")]);

      const claimedIds = new Set([...a.claimedIds, ...b.claimedIds]);
      for (const msg of messages) {
        expect(claimedIds.has(msg.id)).toBe(true);
      }
      expect(claimedIds.size).toBe(messages.length);
    },
    20_000
  );

  it(
    "repeated races produce no double-claim across real processes (stress the advisory-lock path, not just one lucky interleaving)",
    async () => {
      // Each call scans the whole `messages` table, not one conversation -
      // so across iterations, assert scoped to THIS iteration's
      // conversation_id via a direct DB query, not by combining the two
      // processes' own claimedIds arrays. A worker's single claim call can
      // legitimately pick up a DIFFERENT, unrelated conversation's eligible
      // row instead of contesting this one (there's no requirement that two
      // concurrent callers contest the SAME conversation) - the actual
      // guarantee under test is "this conversation never has two rows
      // processing at once", not "the two calls necessarily raced each
      // other." Each iteration's rows are marked 'done' afterward so they
      // don't linger as ambiguous candidates for a later iteration.
      for (let i = 0; i < 5; i++) {
        const conversationId = await freshConversation();
        await insertUserMessage(pool, conversationId, `first-${i}`);
        await insertUserMessage(pool, conversationId, `second-${i}`);

        await Promise.all([runClaimCli(`worker-a-${i}`), runClaimCli(`worker-b-${i}`)]);

        const { rows } = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM messages WHERE conversation_id = $1 AND status = 'processing'`,
          [conversationId]
        );
        expect(rows[0].count).toBe("1");

        await pool.query(`UPDATE messages SET status = 'done', lease_expires_at = NULL WHERE conversation_id = $1`, [
          conversationId,
        ]);
      }
    },
    60_000
  );
});
