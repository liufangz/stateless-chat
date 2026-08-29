// Operator recovery path (Phase 1 reliability): resets a single stuck or
// failed user message back to 'pending' so the normal worker claim loop
// picks it up again, instead of ever auto-requeuing rows in bulk at
// startup. Safe by construction: requeueMessageForRetry only touches a
// 'failed' row, or a 'processing' row whose lease has already expired - a
// row a worker is actively holding a live lease on is left untouched, so
// this can't cause duplicate execution.
//
// Usage: npx tsx scripts/requeue-message.ts <messageId>

import { createPool, requeueMessageForRetry, getMessage } from "@stateless-chat/shared";

const messageId = process.argv[2];
if (!messageId) {
  console.error("usage: npx tsx scripts/requeue-message.ts <messageId>");
  process.exit(1);
}

const pool = createPool();
try {
  const before = await getMessage(pool, messageId);
  if (!before) {
    console.error(`no message found with id ${messageId}`);
    process.exit(1);
  }
  console.log(
    `message ${messageId}: status=${before.status} attempt_count=${before.attempt_count ?? 0} ` +
      `last_error=${before.last_error ?? "(none)"}`
  );

  const requeued = await requeueMessageForRetry(pool, messageId);
  if (!requeued) {
    console.error(
      "not requeued: message is not a user row, is already pending/done, or a worker currently " +
        "holds a live (non-expired) processing lease on it - wait for that lease to expire, or check " +
        "again shortly if a worker is actively processing it."
    );
    process.exit(1);
  }
  console.log(`requeued ${messageId} as 'pending' - it will be picked up by the next worker poll.`);
} finally {
  await pool.end();
}
