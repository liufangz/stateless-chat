// Operator recovery path (Phase 3 reliability): records the real,
// human-verified outcome of a tool call that was left pending by a worker
// crash and that turn-recovery.ts refused to auto-retry because the tool
// can have effects outside the database (see packages/worker/src/turn-
// recovery.ts for why - a mutating tool's actual execution status in that
// crash window is unknown, and guessing either way risks a wrong answer or
// a duplicated side effect).
//
// Typical flow: a message ends up 'failed' with last_error mentioning an
// unresolved tool call. An operator manually checks whatever the tool
// touched (e.g. did the file actually get written? did the command actually
// run?), then runs this script to record what really happened, then
// requeues the message so the turn can continue from a fully-resolved
// state.
//
// Usage:
//   npx tsx scripts/resolve-tool-call.ts <messageId> <toolCallId> <result> [--error]
//
// Then: npx tsx scripts/requeue-message.ts <messageId>

import { createPool, getMessage, getMessagesByReplyTo, insertToolResult } from "@stateless-chat/shared";

const [messageId, toolCallId, result, ...rest] = process.argv.slice(2);
const isError = rest.includes("--error");

if (!messageId || !toolCallId || result === undefined) {
  console.error(
    "usage: npx tsx scripts/resolve-tool-call.ts <messageId> <toolCallId> <result> [--error]"
  );
  process.exit(1);
}

const pool = createPool();
try {
  const message = await getMessage(pool, messageId);
  if (!message || message.role !== "user") {
    console.error(`no user message found with id ${messageId}`);
    process.exit(1);
  }

  // Refuse to touch a row a worker is actively holding a live lease on -
  // same safety condition as requeueMessageForRetry, so this can't race an
  // in-flight attempt into persisting a conflicting result.
  const leaseIsLive =
    message.status === "processing" &&
    message.lease_expires_at != null &&
    new Date(message.lease_expires_at).getTime() > Date.now();
  if (leaseIsLive) {
    console.error(
      "refusing: a worker currently holds a live processing lease on this message - wait for it to " +
        "finish or expire before manually resolving a tool call on it."
    );
    process.exit(1);
  }

  const rows = await getMessagesByReplyTo(pool, messageId);
  const requestRow = rows.find(
    (r) => r.role === "assistant" && (r.tool_calls ?? []).some((tc) => tc.id === toolCallId)
  );
  const pendingCall = requestRow?.tool_calls?.find((tc) => tc.id === toolCallId);
  if (!pendingCall) {
    console.error(`no tool-call request with id ${toolCallId} found on turn ${messageId}`);
    process.exit(1);
  }
  const alreadyResolved = rows.some((r) => r.role === "tool" && r.tool_call_id === toolCallId);
  if (alreadyResolved) {
    console.error(`tool call ${toolCallId} (${pendingCall.name}) already has a recorded result - nothing to do`);
    process.exit(1);
  }

  await insertToolResult(pool, message.conversation_id, messageId, {
    toolCallId,
    toolName: pendingCall.name,
    result,
    isError,
  });

  console.log(
    `recorded ${isError ? "error " : ""}result for tool call ${toolCallId} (${pendingCall.name}) on turn ${messageId}.`
  );
  console.log(`next: npx tsx scripts/requeue-message.ts ${messageId}`);
} finally {
  await pool.end();
}
