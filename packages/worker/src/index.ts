import { randomUUID } from "node:crypto";
import {
  env,
  createPool,
  claimPendingMessages,
  getConversation,
  getConversationHistory,
  getLatestCompaction,
  insertAssistantMessage,
  insertCompaction,
  insertToolCallRequest,
  insertToolResult,
  markMessageDone,
  markMessageFailed,
  renewLease,
  setConversationTitle,
  stillOwnsLease,
  sweepExhaustedLeases,
  createRedisClient,
  createRedisSubscriber,
  NEW_MESSAGE_CHANNEL,
  streamChannel,
  estimateHistoricalContextTokens,
} from "@stateless-chat/shared";
import type { Message } from "@stateless-chat/shared";
import { generateTitle } from "./llm.js";
import { runToolLoop, DEFAULT_TOOLS } from "./tool-loop.js";
import type { CompactionEntry, ToolEvent } from "./tool-loop.js";
import { Lifecycle, createLoggingHooks } from "./lifecycle.js";
import type { LifecycleMessage } from "./lifecycle.js";
import { reconcileTurnState } from "./turn-recovery.js";

const pool = createPool();
const publisher = createRedisClient();
const subscriber = createRedisSubscriber();

const POLL_INTERVAL_MS = 1000;
let claiming = false;
let shuttingDown = false;

// Tracks turns currently in flight so a graceful shutdown can wait for them
// (up to env.drainTimeoutMs) instead of killing them outright.
const inFlight = new Set<Promise<void>>();

/**
 * Auto-titling: after any completed turn, if the conversation doesn't have a
 * title yet, summarize this turn's exchange into a short one and persist it.
 * Runs before markMessageDone/publishing "done" so a client's post-done
 * conversation-list refresh already sees it - the gateway's SSE handler
 * closes the stream right on "done" (see packages/gateway/src/index.ts), so
 * anything published after that would have no listener left to reach.
 *
 * Deliberately has no dedicated failure-recovery mechanism: a failure here
 * (model error, empty completion, etc.) just leaves the conversation
 * untitled, and setConversationTitle's "WHERE title IS NULL" guard means the
 * very next completed turn (new conversation or pre-existing one) retries
 * this for free. Never let a titling failure fail the turn itself.
 */
async function maybeGenerateTitle(
  conversationId: string,
  userContent: string,
  assistantContent: string,
  log: (...args: unknown[]) => void
): Promise<void> {
  try {
    const conversation = await getConversation(pool, conversationId);
    if (!conversation || conversation.title) return;
    const title = await generateTitle(userContent, assistantContent);
    if (title) await setConversationTitle(pool, conversationId, title);
  } catch (err) {
    log("title generation failed (non-fatal, will retry on a later turn)", err);
  }
}

async function processMessage(message: Message) {
  const log = (...args: unknown[]) =>
    console.log(`[worker ${env.workerId}]`, `msg=${message.id}`, ...args);

  log("claimed, generating reply");
  const channel = streamChannel(message.id);

  // pi-style lifecycle: one Lifecycle registry per processed message (an
  // "agent run" in pi terms). The worker itself emits agent/message events
  // here; turn/message/tool events are emitted from inside runToolLoop. A
  // listener forwards every event to the client's SSE stream so a UI can
  // render the full agent/turn/message/tool lifecycle, and (like pi)
  // listener promises are awaited in order and part of the run's
  // settlement - a throwing listener fails the turn.
  const lifecycle = new Lifecycle();
  const agentMessages: LifecycleMessage[] = [{ role: "user", content: message.content ?? "" }];
  lifecycle.on((event) => {
    publisher
      .publish(channel, JSON.stringify(event))
      .catch((err) => log("publish lifecycle event failed", err));
  });
  await lifecycle.emit({ type: "agent_start" });
  await lifecycle.emit({ type: "message_start", message: agentMessages[0] });
  await lifecycle.emit({ type: "message_end", message: agentMessages[0] });

  // Renewed on an interval while the turn runs, so a long-running LLM/tool
  // loop doesn't have its lease expire (and the row get reclaimed by
  // another worker) out from under it. If renewal ever fails, another
  // worker has presumably already reclaimed this row - we can't safely
  // cancel the in-flight LLM call, but the ownership check right before
  // persisting results (below) prevents a duplicate write in that case.
  const heartbeat = setInterval(() => {
    renewLease(pool, message.id, env.workerId, env.leaseDurationMs)
      .then((renewed) => {
        if (!renewed) {
          log("WARNING: lease renewal failed - another worker may now own this row");
        }
      })
      .catch((err) => log("lease renewal error", err));
  }, env.leaseHeartbeatMs);

  try {
    // Phase 3 recovery: this row may be a fresh claim, or a reclaim of a
    // turn a previous (crashed/killed/restarted) worker got partway
    // through. Reconcile durable state BEFORE touching the LLM at all, so
    // we never re-run a step that already has a committed result, and
    // never silently guess the outcome of a mutating tool call left
    // dangling by a crash.
    const reconciled = await reconcileTurnState(pool, DEFAULT_TOOLS, message.conversation_id, message.id);

    if (reconciled.kind === "already-final") {
      // A previous attempt already produced and durably persisted this
      // turn's final answer - only markMessageDone/publish were missed
      // (the crash landed after checkpoint 5, before/during checkpoint 6).
      // Complete the turn from that row without contacting the LLM again,
      // so the client never sees (and the model never generates) a second
      // answer for the same turn.
      if (!(await stillOwnsLease(pool, message.id, env.workerId))) {
        log("lease no longer owned while completing an already-final turn - not overwriting");
        return;
      }
      const reply = reconciled.reply;
      const durationMs = reply.duration_ms ?? null;
      const hasUsage = reply.prompt_tokens != null && reply.completion_tokens != null;
      const speedTps =
        hasUsage && durationMs && durationMs > 0
          ? Math.round((reply.completion_tokens! / (durationMs / 1000)) * 10) / 10
          : null;
      // Legacy rows predate context_tokens - estimate the actually-retained
      // history (system prompt + rows since the latest compaction boundary)
      // instead of falling back to the cumulative prompt_tokens, which can
      // vastly overstate context on a tool-heavy turn. Only fetched when
      // actually needed.
      let contextTokens = reply.context_tokens ?? null;
      if (hasUsage && contextTokens == null) {
        const historyRows = await getConversationHistory(pool, message.conversation_id);
        const latestCompaction = await getLatestCompaction(pool, message.conversation_id);
        contextTokens = estimateHistoricalContextTokens(historyRows, reply.id, latestCompaction);
      }
      // This turn's reply was generated by a previous (crashed) attempt, so
      // the tool loop never streamed message events for it - emit a synthetic
      // assistant message_start/message_end so listeners see the full
      // message lifecycle for every turn, not just freshly generated ones.
      const recoveredMsg: LifecycleMessage = { role: "assistant", content: reply.content };
      agentMessages.push(recoveredMsg);
      await lifecycle.emit({ type: "message_start", message: recoveredMsg });
      await lifecycle.emit({ type: "message_end", message: recoveredMsg });
      await maybeGenerateTitle(message.conversation_id, message.content ?? "", reply.content, log);
      await markMessageDone(pool, message.id);
      await publisher.publish(
        channel,
        JSON.stringify({
          type: "done",
          messageId: message.id,
          content: reply.content,
          usage: hasUsage
            ? {
                promptTokens: reply.prompt_tokens,
                completionTokens: reply.completion_tokens,
                totalTokens: (reply.prompt_tokens ?? 0) + (reply.completion_tokens ?? 0),
                contextTokens: contextTokens ?? 0,
              }
            : null,
          speedTps,
          durationMs,
        })
      );
      log("done (recovered: final reply was already durably persisted by a previous attempt)");
      return;
    }

    if (reconciled.kind === "blocked-mutation") {
      // A previous attempt crashed with an unresolved mutating tool call -
      // see turn-recovery.ts for why this can't be resolved automatically.
      // Fail the turn with a diagnosable reason instead of guessing;
      // requeuing this message will hit the same block until an operator
      // resolves it with scripts/resolve-tool-call.ts.
      if (await stillOwnsLease(pool, message.id, env.workerId)) {
        await markMessageFailed(pool, message.id, reconciled.reason);
        await publisher.publish(channel, JSON.stringify({ type: "error", message: reconciled.reason }));
      } else {
        log("lease no longer owned while blocking on an unresolved mutation - not overwriting");
      }
      log("blocked: unresolved mutating tool call from a previous crash needs manual resolution");
      return;
    }

    const history = await getConversationHistory(pool, message.conversation_id);
    const latestCompaction = await getLatestCompaction(pool, message.conversation_id);
    const { content, usage } = await runToolLoop(
      history,
      (token) => {
        publisher
          .publish(channel, JSON.stringify({ type: "token", content: token }))
          .catch((err) => log("publish token failed", err));
      },
      (event: ToolEvent) => {
        publisher
          .publish(channel, JSON.stringify(event))
          .catch((err) => log("publish tool event failed", err));
      },
      {
        startIteration: reconciled.startIteration,
        lifecycle,
        hooks: createLoggingHooks(log),
        persistence: {
          // Durable checkpoint #1 (before any tool in this iteration
          // executes): re-check ownership right here, as close to
          // execution as we can get, so a worker whose lease was reclaimed
          // mid-generation stops before running (not just before
          // persisting) another iteration's tools. This narrows, but per
          // Phase 1's existing design can't fully close, the window where
          // two workers both execute a tool concurrently - see
          // packages/worker/src/index.ts's existing heartbeat comment for
          // why an in-flight LLM/tool call can't be cancelled outright.
          onToolCallRequest: async (iteration, calls) => {
            if (!(await stillOwnsLease(pool, message.id, env.workerId))) {
              throw new Error("lease lost before persisting tool-call request - aborting turn");
            }
            await insertToolCallRequest(pool, message.conversation_id, message.id, iteration, calls);
          },
          // Durable checkpoint #2 (immediately after execution, before the
          // next tool or LLM continuation): idempotent, so a duplicate
          // call here (e.g. a race with turn-recovery resolving the same
          // pending call) is safely a no-op rather than a duplicate row.
          onToolResult: async (record) => {
            await insertToolResult(pool, message.conversation_id, message.id, record);
          },
        },
        compaction: {
          enabled: env.compactionEnabled,
          thresholdTokens: env.compactionThresholdTokens,
          keepRecentTokens: env.compactionKeepRecentTokens,
          previousSummary: latestCompaction?.summary ?? null,
          previousSummaryFirstKeptMessageId: latestCompaction?.first_kept_message_id ?? null,
          onCompaction: async (entry: CompactionEntry) => {
            log(`compact: ${entry.tokensBefore} tokens -> summary`);
            await insertCompaction(pool, {
              id: randomUUID(),
              conversationId: message.conversation_id,
              triggeredByMessageId: message.id,
              summary: entry.summary,
              firstKeptMessageId: entry.firstKeptMessageId,
              sourceStartMessageId: entry.sourceStartMessageId,
              tokensBefore: entry.tokensBefore,
              promptTokens: entry.promptTokens,
              completionTokens: entry.completionTokens,
            });
          },
        },
      }
    );

    // Final ownership guard: if another worker reclaimed this row while we
    // were generating (our heartbeat failed to renew in time), skip
    // persisting - writing now would risk a duplicate assistant reply for
    // the same turn. The reclaiming worker's own run is authoritative.
    if (!(await stillOwnsLease(pool, message.id, env.workerId))) {
      log("lease no longer owned after generation finished - discarding result, not persisting");
      return;
    }

    const durationMs = usage?.streamMs ?? null;
    const speedTps =
      usage && usage.streamMs > 0
        ? Math.round((usage.completionTokens / (usage.streamMs / 1000)) * 10) / 10
        : null;

    // Durable checkpoint #3 (final answer): idempotent - if a previous
    // attempt somehow already committed this turn's final reply (it
    // shouldn't have gotten this far without the already-final branch
    // above catching it first, but this is the last line of defense), the
    // unique index makes this a no-op and returns that row instead of
    // creating a duplicate.
    const reply = await insertAssistantMessage(
      pool,
      message.conversation_id,
      message.id,
      content,
      usage
        ? {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            durationMs,
            contextTokens: usage.contextTokens,
          }
        : null
    );
    // The tool loop already streamed this message's start/update/end events;
    // just record it for the agent_end summary.
    agentMessages.push({ role: "assistant", content: reply.content });
    // reply.content !== content only in the last-line-of-defense case above
    // (another attempt's row won the race) - in that case usage/speedTps
    // computed from this run's `usage` describe a generation that was
    // discarded, not the row that actually got persisted, so don't publish
    // them alongside content that doesn't match.
    const wonInsert = reply.content === content;
    await maybeGenerateTitle(message.conversation_id, message.content ?? "", reply.content, log);
    await markMessageDone(pool, message.id);
    await publisher.publish(
      channel,
      JSON.stringify({
        type: "done",
        messageId: message.id,
        content: reply.content,
        usage:
          wonInsert && usage
            ? {
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                contextTokens: usage.contextTokens,
              }
            : null,
        speedTps: wonInsert ? speedTps : null,
        durationMs: wonInsert ? durationMs : reply.duration_ms ?? null,
      })
    );
    log(wonInsert ? "done" : "done (another attempt's final reply won the race - publishing that one)");
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "unknown error";
    console.error(`[worker ${env.workerId}] msg=${message.id} failed`, err);
    if (await stillOwnsLease(pool, message.id, env.workerId)) {
      await markMessageFailed(pool, message.id, errorMessage);
      await publisher.publish(
        channel,
        JSON.stringify({ type: "error", message: errorMessage })
      );
    } else {
      log("lease no longer owned after failure - not overwriting the reclaiming worker's row");
    }
  } finally {
    clearInterval(heartbeat);
    // pi-style agent_end: emitted on every exit path (success, recovery,
    // blocked, error, lease-lost) so listeners always see the run close out.
    // Wrapped in its own try/catch so a terminal bookkeeping failure can't
    // mask the outcome the turn actually produced.
    try {
      await lifecycle.emit({ type: "agent_end", messages: agentMessages });
    } catch (err) {
      log("lifecycle agent_end emission failed", err);
    }
  }
}

async function claimAndProcess() {
  if (claiming || shuttingDown) return; // avoid overlapping claim batches from the same worker
  claiming = true;
  try {
    await sweepExhaustedLeases(pool, env.maxClaimAttempts);
    // Process one turn at a time. This prevents two turns from the same
    // conversation being reclaimed together and interleaving their durable
    // assistant/tool rows, which would produce an invalid model history.
    const claimed = await claimPendingMessages(pool, env.workerId, env.leaseDurationMs, 1);
    for (const message of claimed) {
      // Await the turn before claiming another one. Tracked in `inFlight`
      // so a graceful shutdown can still drain the active turn.
      const task = processMessage(message);
      inFlight.add(task);
      try {
        await task;
      } finally {
        inFlight.delete(task);
      }
    }
  } catch (err) {
    console.error(`[worker ${env.workerId}] claim loop error`, err);
  } finally {
    claiming = false;
  }
}

/**
 * Stops claiming new work immediately, then gives active turns up to
 * env.drainTimeoutMs to finish naturally. Anything still running past the
 * deadline is left as-is: its lease keeps ticking and will expire on its
 * own once this process exits, making it reclaimable by another worker
 * instead of silently stuck in 'processing' forever.
 */
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker ${env.workerId}] ${signal} received, draining (up to ${env.drainTimeoutMs}ms)...`);

  clearInterval(pollTimer);
  await subscriber.unsubscribe().catch(() => {});

  const inFlightCount = inFlight.size;
  if (inFlightCount > 0) {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, env.drainTimeoutMs));
    await Promise.race([Promise.allSettled([...inFlight]), timeout]);
    if (inFlight.size > 0) {
      console.log(
        `[worker ${env.workerId}] drain window elapsed with ${inFlight.size} turn(s) still in flight - ` +
          `leaving them for lease reclaim`
      );
    }
  }

  await Promise.allSettled([subscriber.quit(), publisher.quit(), pool.end()]);
  console.log(`[worker ${env.workerId}] shutdown complete`);
  process.exit(0);
}

let pollTimer: NodeJS.Timeout;

async function main() {
  console.log(`[worker ${env.workerId}] starting`);

  // Wake up immediately when the gateway publishes a new message...
  subscriber.on("message", () => {
    void claimAndProcess();
  });
  await subscriber.subscribe(NEW_MESSAGE_CHANNEL);

  // ...and also poll on an interval, so messages published before this
  // worker connected (or a missed pubsub notification, or a lease that
  // simply expired with no notification at all) are still picked up.
  pollTimer = setInterval(() => void claimAndProcess(), POLL_INTERVAL_MS);
  void claimAndProcess();

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log(`[worker ${env.workerId}] ready, waiting for messages`);
}

main().catch((err) => {
  console.error(`[worker ${env.workerId}] fatal error`, err);
  process.exit(1);
});
