import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";

// Repo layout is <root>/packages/shared/src/env.ts, so three levels up is <root>,
// where the real .env (with the OpenAI-compatible key) lives.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../");
dotenv.config({ path: path.join(repoRoot, ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://chat:chat@localhost:5433/chat",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6380",
  gatewayPort: Number(process.env.GATEWAY_PORT ?? 3000),
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
  authPassword: required("AUTH_PASSWORD"),
  authSecret: required("AUTH_SECRET"),
  // When true, the gateway ignores clientId on list/delete so every
  // authenticated user sees all conversations (shared-history mode).
  // Unset or "false" restores per-device clientId scoping.
  disableClientScoping: process.env.DISABLE_CLIENT_SCOPING === "true",
  // When true, the worker's DEFAULT_TOOLS includes the sandboxed `bash`
  // tool. Unset or "false" keeps it disabled.
  toolBashEnabled: process.env.TOOL_BASH_ENABLED === "true",
};
