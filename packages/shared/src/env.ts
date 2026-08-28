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
  // File tools run in-process (not docker-routed) - each flag requires a
  // worker restart to take effect, same as toolBashEnabled. write_file
  // should not be enabled without read_file in practice (the model needs to
  // read back drafted content), though nothing enforces that here.
  toolReadFileEnabled: process.env.TOOL_READ_FILE_ENABLED === "true",
  toolWriteFileEnabled: process.env.TOOL_WRITE_FILE_ENABLED === "true",
  toolEditFileEnabled: process.env.TOOL_EDIT_FILE_ENABLED === "true",
  // History window fed to the LLM per turn, in ROWS (not tokens). 0 =
  // unlimited - the entire conversation is passed without slicing. Default
  // 20 keeps the token-bounded behavior; tool-heavy turns inflate row count
  // fast, so unlimited risks DeepSeek 400 / overflow on long chats. Ignored
  // when compactionEnabled is true - compaction owns the budget instead.
  toolLoopHistoryLimit: Number(process.env.TOOL_LOOP_HISTORY_LIMIT ?? 20),
  // pi has NO iteration cap on its tool loop. This is a cost fuse, not a
  // behavior cap: compaction (below) owns context growth, so the fuse only
  // exists so a pathological loop that never stops calling tools can't run
  // forever. When it trips, tool-loop.ts takes the answer-now retry path,
  // not a hard failure.
  toolLoopMaxIterations: Number(process.env.TOOL_LOOP_MAX_ITERATIONS ?? 200),
  // pi-style token-budgeted auto-compaction: summarizes old conversation
  // turns with the LLM instead of hard-slicing rows. Master switch - when
  // false, tool-loop falls back to the row-slice behavior above unchanged.
  compactionEnabled: (process.env.COMPACTION_ENABLED ?? "true") === "true",
  // Trigger threshold, in estimated tokens (system + summary + all
  // messages). Crossing this triggers a compaction pass before the next LLM
  // call.
  compactionThresholdTokens: Number(process.env.COMPACTION_THRESHOLD_TOKENS ?? 40000),
  // How much of the newest context (in estimated tokens) survives a
  // compaction pass, walking backward from the newest message.
  compactionKeepRecentTokens: Number(process.env.COMPACTION_KEEP_RECENT_TOKENS ?? 20000),
};
