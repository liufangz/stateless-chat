import {
  env,
  createPool,
  claimPendingMessages,
  getConversationHistory,
  insertAssistantMessage,
  insertToolExchange,
  markMessageStatus,
  createRedisClient,
  createRedisSubscriber,
  NEW_MESSAGE_CHANNEL,
  streamChannel,
} from "@stateless-chat/shared";
import type { Message } from "@stateless-chat/shared";
import { runToolLoop } from "./tool-loop.js";
import type { ToolEvent } from "./tool-loop.js";

const pool = createPool();
const publisher = createRedisClient();
const subscriber = createRedisSubscriber();

const POLL_INTERVAL_MS = 1000;
let claiming = false;

async function processMessage(message: Message) {
  const log = (...args: unknown[]) =>
    console.log(`[worker ${env.workerId}]`, `msg=${message.id}`, ...args);

  log("claimed, generating reply");
  const channel = streamChannel(message.id);

  try {
    const history = await getConversationHistory(pool, message.conversation_id);
    const { content, toolExchange, usage } = await runToolLoop(
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
      }
    );

    if (toolExchange.length > 0) {
      await insertToolExchange(pool, message.conversation_id, message.id, toolExchange);
    }

    const durationMs = usage?.streamMs ?? null;
    const speedTps =
      usage && usage.streamMs > 0
        ? Math.round((usage.completionTokens / (usage.streamMs / 1000)) * 10) / 10
        : null;

    await insertAssistantMessage(
      pool,
      message.conversation_id,
      message.id,
      content,
      usage
        ? {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            durationMs,
          }
        : null
    );
    await markMessageStatus(pool, message.id, "done");
    await publisher.publish(
      channel,
      JSON.stringify({
        type: "done",
        messageId: message.id,
        content,
        usage: usage
          ? {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }
          : null,
        speedTps,
        durationMs,
      })
    );
    log("done");
  } catch (err) {
    console.error(`[worker ${env.workerId}] msg=${message.id} failed`, err);
    await markMessageStatus(pool, message.id, "failed");
    await publisher.publish(
      channel,
      JSON.stringify({
        type: "error",
        message: err instanceof Error ? err.message : "unknown error",
      })
    );
  }
}

async function claimAndProcess() {
  if (claiming) return; // avoid overlapping claim batches from the same worker
  claiming = true;
  try {
    const claimed = await claimPendingMessages(pool, 5);
    for (const message of claimed) {
      // Fire-and-forget: process concurrently, don't block the claim loop.
      void processMessage(message);
    }
  } catch (err) {
    console.error(`[worker ${env.workerId}] claim loop error`, err);
  } finally {
    claiming = false;
  }
}

async function main() {
  console.log(`[worker ${env.workerId}] starting`);

  // Wake up immediately when the gateway publishes a new message...
  subscriber.on("message", () => {
    void claimAndProcess();
  });
  await subscriber.subscribe(NEW_MESSAGE_CHANNEL);

  // ...and also poll on an interval, so messages published before this
  // worker connected (or a missed pubsub notification) are still picked up.
  setInterval(() => void claimAndProcess(), POLL_INTERVAL_MS);
  void claimAndProcess();

  console.log(`[worker ${env.workerId}] ready, waiting for messages`);
}

main().catch((err) => {
  console.error(`[worker ${env.workerId}] fatal error`, err);
  process.exit(1);
});
