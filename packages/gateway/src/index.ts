import { timingSafeEqual } from "node:crypto";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import {
  env,
  createPool,
  initSchema,
  createConversation,
  getConversation,
  listConversations,
  deleteConversation,
  insertUserMessage,
  getMessage,
  getReply,
  getConversationHistory,
  getCompactionsForConversation,
  getMessagesByReplyTo,
  createRedisClient,
  createRedisSubscriber,
  NEW_MESSAGE_CHANNEL,
  streamChannel,
  createAuthToken,
  verifyAuthToken,
  AUTH_COOKIE_NAME,
  AUTH_COOKIE_MAX_AGE_MS,
} from "@stateless-chat/shared";
import type { StreamEvent } from "@stateless-chat/shared";
import { parseCookies, serializeCookie } from "./cookies.js";
import { groupMessagesForClient } from "./group-history.js";

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

// Constant-time password compare. Buffers of unequal length are padded to
// avoid leaking the correct password's length via timingSafeEqual's throw.
function passwordMatches(candidate: string, expected: string): boolean {
  const candidateBuf = Buffer.from(candidate);
  const expectedBuf = Buffer.from(expected);
  if (candidateBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(candidateBuf, expectedBuf);
}

// Trivial in-memory throttle so a script can't hammer /login. Not durable
// across restarts and not shared across instances - good enough for a
// single shared password with no real account-lockout requirement.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

function setAuthCookie(res: Response): void {
  const token = createAuthToken(env.authSecret);
  res.setHeader(
    "Set-Cookie",
    serializeCookie(AUTH_COOKIE_NAME, token, {
      maxAgeSeconds: AUTH_COOKIE_MAX_AGE_MS / 1000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    })
  );
}

function clearAuthCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(AUTH_COOKIE_NAME, "", {
      maxAgeSeconds: 0,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    })
  );
}

function isAuthenticated(req: Request): boolean {
  const cookies = parseCookies(req.headers.cookie);
  return verifyAuthToken(cookies[AUTH_COOKIE_NAME], env.authSecret);
}

async function main() {
  await initSchema(pool);
  console.log("[gateway] schema ready");

  const app = express();
  app.use(express.json());

  // --- Auth routes: unauthenticated by design, must exist before the
  // requireAuth gate below. Never set WWW-Authenticate - that header is
  // what triggers the browser's native basic-auth dialog we're removing.
  app.post(
    "/login",
    asyncHandler(async (req: Request, res: Response) => {
      const key = req.ip ?? "unknown";
      if (isRateLimited(key)) {
        res.status(429).json({ error: "too many attempts, try again later" });
        return;
      }
      const password = String(req.body?.password ?? "");
      if (!passwordMatches(password, env.authPassword)) {
        res.status(401).json({ error: "invalid password" });
        return;
      }
      setAuthCookie(res);
      res.status(204).end();
    })
  );

  app.post("/logout", (_req: Request, res: Response) => {
    clearAuthCookie(res);
    res.status(204).end();
  });

  app.get("/auth/status", (req: Request, res: Response) => {
    if (isAuthenticated(req)) {
      res.status(200).json({ authenticated: true });
    } else {
      res.status(401).json({ authenticated: false });
    }
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  // Everything below requires a valid auth cookie.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isAuthenticated(req)) {
      next();
      return;
    }
    res.status(401).json({ error: "unauthorized" });
  });

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

  // List conversations, most recently active first. Scoped to a clientId so
  // each browser only sees its own conversations — unless client scoping is
  // disabled (DISABLE_CLIENT_SCOPING=true), which shows all conversations.
  app.get(
    "/conversations",
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = env.disableClientScoping
        ? ""
        : typeof req.query.clientId === "string"
          ? req.query.clientId.trim()
          : "";
      const conversations = await listConversations(pool, clientId || undefined);
      res.status(200).json({ conversations });
    })
  );

  // Delete a conversation and all of its messages. Scoped by clientId (query
  // or body) when provided, so a client can't delete another client's
  // conversation — unless client scoping is disabled.
  app.delete(
    "/conversations/:conversationId",
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = env.disableClientScoping
        ? ""
        : String(req.query.clientId ?? req.body?.clientId ?? "").trim();
      const deleted = await deleteConversation(
        pool,
        req.params.conversationId,
        clientId || undefined
      );
      if (!deleted) {
        res.status(404).json({ error: "conversation not found" });
        return;
      }
      res.status(204).end();
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
      const compactions = await getCompactionsForConversation(
        pool,
        req.params.conversationId
      );
      res.status(200).json({
        conversationId: conversation.id,
        messages: groupMessagesForClient(messages),
        compactions: compactions.map((c) => ({
          id: c.id,
          summary: c.summary,
          createdAt: c.created_at,
          promptTokens: c.prompt_tokens,
          completionTokens: c.completion_tokens,
        })),
      });
    })
  );

  // Full tool exchange (arguments + results) for a single turn, keyed by the
  // USER message id - that's the join key both the worker and the grouped
  // history response use for `reply_to_message_id`. Chips in the history
  // response carry only name/arguments/isError; this is where result
  // content comes from, fetched on demand when a chip is expanded.
  app.get(
    "/conversations/:conversationId/messages/:messageId/tools",
    asyncHandler(async (req: Request, res: Response) => {
      const { conversationId, messageId } = req.params;

      const conversation = await getConversation(pool, conversationId);
      if (!conversation) {
        res.status(404).json({ error: "conversation not found" });
        return;
      }
      const userMessage = await getMessage(pool, messageId);
      if (!userMessage || userMessage.conversation_id !== conversationId) {
        res.status(404).json({ error: "message not found" });
        return;
      }

      const rows = await getMessagesByReplyTo(pool, messageId);
      const resultByCallId = new Map<string, { content: string; isError: boolean }>();
      for (const row of rows) {
        if (row.role === "tool" && row.tool_call_id) {
          resultByCallId.set(row.tool_call_id, {
            content: row.content,
            isError: !!row.tool_is_error,
          });
        }
      }

      const toolCalls = rows
        .filter((row) => row.role === "assistant" && row.tool_calls && row.tool_calls.length > 0)
        .flatMap((row) =>
          (row.tool_calls ?? []).map((tc) => {
            const outcome = resultByCallId.get(tc.id);
            return {
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
              result: outcome?.content ?? "",
              isError: outcome?.isError ?? false,
            };
          })
        );

      res.status(200).json({ conversationId, messageId, toolCalls });
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
        } else if (event.type === "tool_start") {
          send("tool_start", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
        } else if (event.type === "tool_end") {
          send("tool_end", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
          });
        } else if (event.type === "done") {
          send("done", {
            content: event.content,
            usage: event.usage,
            speedTps: event.speedTps,
            durationMs: event.durationMs,
          });
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
        const hasUsage = existingReply.prompt_tokens != null && existingReply.completion_tokens != null;
        const durationMs = existingReply.duration_ms ?? null;
        send("token", { content: existingReply.content });
        send("done", {
          content: existingReply.content,
          usage: hasUsage
            ? {
                promptTokens: existingReply.prompt_tokens,
                completionTokens: existingReply.completion_tokens,
                totalTokens: (existingReply.prompt_tokens ?? 0) + (existingReply.completion_tokens ?? 0),
              }
            : null,
          speedTps:
            hasUsage && durationMs && durationMs > 0
              ? Math.round((existingReply.completion_tokens! / (durationMs / 1000)) * 10) / 10
              : null,
          durationMs,
        });
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

  app.listen(env.gatewayPort, () => {
    console.log(`[gateway] listening on :${env.gatewayPort}`);
  });
}

main().catch((err) => {
  console.error("[gateway] fatal error", err);
  process.exit(1);
});
