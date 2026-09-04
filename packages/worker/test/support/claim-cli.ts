// Standalone script (NOT a vitest test file), run as its own OS process by
// db-conversation-claim-cross-process.test.ts, to verify claimPendingMessages's
// conversation-ordering guard (packages/shared/src/db.ts) actually holds
// across genuinely separate Node processes sharing only Postgres - not just
// `Promise.all` within one process/one pg.Pool. Calls with limit=1, the
// exact way the real worker always calls it
// (packages/worker/src/index.ts's claimAndProcess).
//
// Usage: tsx claim-cli.ts <workerId>
import { createPool, claimPendingMessages } from "@stateless-chat/shared";

async function main() {
  const [workerId] = process.argv.slice(2);
  const pool = createPool();
  const claimed = await claimPendingMessages(pool, workerId, 30_000, 1);
  process.stdout.write(JSON.stringify({ claimedIds: claimed.map((m) => m.id) }) + "\n");
  await pool.end();
  process.exit(0);
}

void main();
