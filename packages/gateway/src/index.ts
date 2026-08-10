import express from "express";
import type { Request, Response } from "express";
import {
  env,
  createPool,
  initSchema,
  createConversation,
  getConversation,
  insertUserMessage,
  getMessage,
  getReply,
  getConversationHistory,
  createRedisClient,
  createRedisSubscriber,
  NEW_MESSAGE_CHANNEL,
  streamChannel,
} from "@stateless-chat/shared";
import type { StreamEvent } from "@stateless-chat/shared";

const pool = createPool();
const publisher = createRedisClient();

// Express 4 doesn't catch rejected promises from async handlers, and an
// unhandled rejection would otherwise crash the whole process - wrap every
// route so a single bad request can't take the gateway down.
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      console.error("[gateway] request error", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal error" });
      } else {
        res.end();
      }
    });
  };
}

async function main() {
  await initSchema(pool);
  console.log("[gateway] schema ready");

  const app = express();
  app.use(express.json());

  // Create a new conversation for a client.
  app.post(
    "/conversations",
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = String(req.body?.clientId ?? "").trim();
      if (!clientId) {
        res.status(400).json({ error: "clientId is required" });
        return;
      }
      const conversation = await createConversation(pool, clientId);
      res.status(200).json({ conversationId: conversation.id });
    })
  );

  // Send a message into a conversation. Returns immediately (HTTP 200) once
  // the message is durably stored and a processing notification is
  // published - the LLM reply itself arrives asynchronously via the SSE
  // stream endpoint below.
  app.post(
    "/conversations/:conversationId/messages",
    asyncHandler(async (req: Request, res: Response) => {
      const { conversationId: routeConversationId } = req.params;
      const clientId = String(req.body?.clientId ?? "").trim();
      const content = String(req.body?.content ?? "").trim();

      if (!content) {
        res.status(400).json({ error: "content is required" });
        return;
      }

      let conversationId = routeConversationId;
      if (conversationId === "new") {
        if (!clientId) {
          res
            .status(400)
            .json({ error: "clientId is required to start a new conversation" });
          return;
        }
        const conversation = await createConversation(pool, clientId);
        conversationId = conversation.id;
      } else {
        const conversation = await getConversation(pool, conversationId);
        if (!conversation) {
          res.status(404).json({ error: "conversation not found" });
          return;
        }
      }

      const message = await insertUserMessage(pool, conversationId, content);

      await publisher.publish(
        NEW_MESSAGE_CHANNEL,
        JSON.stringify({ messageId: message.id, conversationId })
      );

      res.status(200).json({
        conversationId,
        messageId: message.id,
        streamUrl: `/conversations/${conversationId}/messages/${message.id}/stream`,
      });
    })
  );

  // Full conversation history, straight from Postgres.
  app.get(
    "/conversations/:conversationId/messages",
    asyncHandler(async (req: Request, res: Response) => {
      const conversation = await getConversation(
        pool,
        req.params.conversationId
      );
      if (!conversation) {
        res.status(404).json({ error: "conversation not found" });
        return;
      }
      const messages = await getConversationHistory(
        pool,
        req.params.conversationId
      );
      res.status(200).json({ conversationId: conversation.id, messages });
    })
  );

  // SSE stream for a single message's assistant reply. Safe to call before,
  // during, or after the reply has been generated - this is what lets a
  // client reconnect (e.g. after a page reload) using just the message id.
  app.get(
    "/conversations/:conversationId/messages/:messageId/stream",
    asyncHandler(async (req: Request, res: Response) => {
      const { conversationId, messageId } = req.params;

      const userMessage = await getMessage(pool, messageId);
      if (!userMessage || userMessage.conversation_id !== conversationId) {
        res.status(404).json({ error: "message not found" });
        return;
      }

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Subscribe BEFORE checking Postgres for a finished reply, and buffer
      // whatever arrives in between, so a reply that finishes exactly
      // between the subscribe call and the DB check is never lost.
      const subscriber = createRedisSubscriber();
      const buffered: StreamEvent[] = [];
      let flushing = false;

      subscriber.on("message", (_channel, raw) => {
        const event = JSON.parse(raw) as StreamEvent;
        if (flushing) {
          deliver(event);
        } else {
          buffered.push(event);
        }
      });
      await subscriber.subscribe(streamChannel(messageId));

      let closed = false;
      let heartbeat: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        subscriber.unsubscribe().catch(() => {});
        subscriber.quit().catch(() => {});
      };
      req.on("close", cleanup);

      function deliver(event: StreamEvent) {
        if (closed) return;
        if (event.type === "token") {
          send("token", { content: event.content });
        } else if (event.type === "done") {
          send("done", { content: event.content });
          res.end();
          cleanup();
        } else if (event.type === "error") {
          send("error", { message: event.message });
          res.end();
          cleanup();
        }
      }

      const existingReply = await getReply(pool, messageId);
      if (existingReply) {
        // Already finished (e.g. client reconnected after the fact) - reply
        // straight from Postgres and ignore anything buffered from Redis.
        send("token", { content: existingReply.content });
        send("done", { content: existingReply.content });
        res.end();
        cleanup();
        return;
      }

      if (userMessage.status === "failed") {
        send("error", { message: "message processing failed" });
        res.end();
        cleanup();
        return;
      }

      flushing = true;
      for (const event of buffered) {
        deliver(event);
      }
      buffered.length = 0;

      heartbeat = setInterval(() => {
        if (!closed) res.write(": ping\n\n");
      }, 15000);
    })
  );

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.listen(env.gatewayPort, () => {
    console.log(`[gateway] listening on :${env.gatewayPort}`);
  });
}

main().catch((err) => {
  console.error("[gateway] fatal error", err);
  process.exit(1);
});
