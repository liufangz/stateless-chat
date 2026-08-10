import { Redis } from "ioredis";
import { env } from "./env.js";

export const NEW_MESSAGE_CHANNEL = "chat:new_message";

export function streamChannel(messageId: string): string {
  return `chat:stream:${messageId}`;
}

/** General-purpose client: publishing, GET/SET, etc. Not put into subscribe mode. */
export function createRedisClient(): Redis {
  return new Redis(env.redisUrl);
}

/** ioredis dedicates a connection to subscribe mode, so callers that need to
 * both publish and subscribe must use two separate client instances. */
export function createRedisSubscriber(): Redis {
  return new Redis(env.redisUrl);
}
