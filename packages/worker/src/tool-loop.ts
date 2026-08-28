import OpenAI from "openai";
import { env } from "@stateless-chat/shared";
import type { Message, ToolExchangeRecord } from "@stateless-chat/shared";
import { DEFAULT_TOOLS } from "./tools/index.js";
import {
  applyCompaction,
  estimateMessagesTokens,
  findAssistantCutPoint,
  findLastUserIndex,
  findTurnCutPoint,
  shouldCompact,
  summarize,
  summarizeTurnPrefix,
} from "./compaction.js";
import type { SummarizationClient } from "./compaction.js";
export { DEFAULT_TOOLS } from "./tools/index.js";
export type { ToolExchangeRecord } from "@stateless-chat/shared";

const SYSTEM_PROMPT =
  "You are a helpful, concise assistant in a chat application. Keep replies short. " +
  "Use the available tools when they would make your answer more accurate (e.g. exact " +
  "date/time or arithmetic) instead of guessing.";

export const HISTORY_LIMIT = 20;
// Multi-file survey tasks (read_file pagination, bash exploration) routinely
// need more than 6 LLM round-trips; 6 caused truncated/fallback answers on
// "go through the project" style prompts (verified 2026-08-26). Raised to 12
// with a matching timeout (DeepSeek round-trips ~3-8s each), then to 20 /
// 300s on 2026-08-26 after a 12-iteration survey (conversation
// a8fc3e11-ee93-44bd-b26f-a958840fef7f) still ended in the fallback message.
// Raised to 50 / 600s on 2026-08-27 at liufangz's request (timeout must
// scale with iterations: 50 x ~8s worst-case round-trips > 300s).
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_TIMEOUT_MS = 600_000;
const FALLBACK_MESSAGE =
  "I wasn't able to finish that using my tools — could you rephrase?";

// --- Minimal structural client/message types -------------------------------
// Deliberately not the full `openai` SDK types: this is the exact subset the
// loop needs, so a test fake only has to implement `chat.completions.create`
// without satisfying the SDK's much larger surface.

export interface ChatToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionChunkChoice {
  delta: {
    content?: string | null;
    tool_calls?: ChatToolCallDelta[];
  };
  finish_reason?: string | null;
}

export interface ChatCompletionChunkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatCompletionChunkLike {
  choices: ChatCompletionChunkChoice[];
  usage?: ChatCompletionChunkUsage | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: ChatMessage[];
        tools?: Array<{
          type: "function";
          function: { name: string; description: string; parameters: unknown };
        }>;
        tool_choice?: "auto";
        stream: true;
        stream_options?: { include_usage: boolean };
      }): Promise<AsyncIterable<ChatCompletionChunkLike>>;
    };
  };
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: unknown): Promise<string> | string;
}

export type ToolEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean };

export interface CompactionEntry {
  summary: string;
  firstKeptMessageId: string;
  tokensBefore: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface CompactionRuntimeOptions {
  enabled: boolean;
  thresholdTokens: number;
  keepRecentTokens: number;
  /** Summary from the conversation's most recent compaction, if any. */
  previousSummary: string | null;
  /**
   * id of `previousSummary`'s first-kept row - where the next summarization
   * span should start, instead of the conversation start. Not part of pi's
   * literal ToolLoopOptions surface, but required to honor "the summarized
   * span starts at the previous compaction's kept boundary" without
   * re-summarizing already-summarized history on every pass.
   */
  previousSummaryFirstKeptMessageId?: string | null;
  /**
   * Called once a pre-turn compaction pass durably needs persisting. Errors
   * are logged, not thrown - a failed persist doesn't invalidate the
   * in-memory compaction already applied to this turn's messages.
   */
  onCompaction?: (entry: CompactionEntry) => Promise<void> | void;
}

export interface ToolLoopOptions {
  client?: ChatCompletionsClient;
  tools?: Tool[];
  maxIterations?: number;
  timeoutMs?: number;
  compaction?: CompactionRuntimeOptions;
}

// --- Loop mechanics -----------------------------------------------------

let defaultClient: ChatCompletionsClient | undefined;
function getDefaultClient(): ChatCompletionsClient {
  if (!defaultClient) {
    defaultClient = new OpenAI({
      apiKey: env.openaiApiKey,
      baseURL: env.openaiBaseUrl,
    }) as unknown as ChatCompletionsClient;
  }
  return defaultClient;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

function tryParseArgsForEvent(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

async function executeToolCall(
  tc: AccumulatedToolCall,
  toolsByName: Map<string, Tool>
): Promise<ToolExecutionResult> {
  const tool = toolsByName.get(tc.name);
  if (!tool) {
    return { content: `Error: unknown tool '${tc.name}'`, isError: true };
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
  } catch (err) {
    return {
      content: `Error: malformed JSON arguments for tool '${tc.name}': ${
        err instanceof Error ? err.message : String(err)
      }`,
      isError: true,
    };
  }

  try {
    const result = await tool.execute(parsedArgs);
    const output = typeof result === "string" ? result : String(result);
    return { content: output.length > 0 ? output : "(empty result)", isError: false };
  } catch (err) {
    return {
      content: `Error: tool '${tc.name}' failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      isError: true,
    };
  }
}

// --- Turn-boundary-aware history slicing --------------------------------
// Once tool rows exist, a raw `history.slice(-N)` can split an assistant
// `tool_calls` row from its `tool` result rows, or include a dangling `tool`
// row with no preceding assistant row - DeepSeek (like OpenAI) rejects a
// `messages` array shaped like that with a 400. So instead of a plain row
// count cut, take the last N rows, then:
//   1. walk the start backward to the nearest preceding 'user' row (a turn
//      boundary), so a partial exchange is never left dangling at the front;
//   2. walk the end forward to include every 'tool' row belonging to the
//      last included tool-call assistant row's exchange group (a no-op in
//      practice today, since the slice is always a suffix of full history,
//      but keeps the function correct if that ever changes).

export function isToolCallAssistantRow(m: Message): boolean {
  return m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

export function sliceHistoryAtTurnBoundaries(history: Message[], limit: number): Message[] {
  if (history.length <= limit) return history;

  let start = history.length - limit;
  while (start > 0 && history[start].role !== "user") {
    start--;
  }

  let end = history.length;
  let i = start;
  while (i < end) {
    const row = history[i];
    if (isToolCallAssistantRow(row)) {
      const pendingCallIds = new Set((row.tool_calls ?? []).map((tc) => tc.id));
      let j = i + 1;
      while (pendingCallIds.size > 0 && j < history.length && history[j].role === "tool") {
        pendingCallIds.delete(history[j].tool_call_id ?? "");
        j++;
      }
      if (j > end) end = j;
      i = j;
    } else {
      i++;
    }
  }

  return history.slice(start, end);
}

export function rowToChatMessage(m: Message): ChatMessage {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.tool_call_id ?? "" };
  }
  if (isToolCallAssistantRow(m)) {
    return {
      role: "assistant",
      content: null,
      tool_calls: (m.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: m.role as "user" | "assistant", content: m.content };
}

export interface RunLoopUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  streamMs: number;
  firstTokenMs: number;
}

export interface RunLoopResult {
  content: string;
  toolExchange: ToolExchangeRecord[];
  usage: RunLoopUsage | null;
}

/**
 * Pre-turn compaction: if the full history (system + every row) is over
 * budget, summarize everything before the cut point and replace it with one
 * summary message. Falls back to the full uncompacted array whenever
 * there's nothing worth cutting or the summarization call itself fails -
 * compaction is a budget optimization, never a hard requirement for the
 * turn to proceed.
 */
async function buildCompactedMessages(
  history: Message[],
  client: ChatCompletionsClient,
  compaction: CompactionRuntimeOptions
): Promise<ChatMessage[]> {
  const systemMessage: ChatMessage = { role: "system", content: SYSTEM_PROMPT };
  const fullChat: ChatMessage[] = [systemMessage, ...history.map(rowToChatMessage)];

  if (!shouldCompact(fullChat, compaction.thresholdTokens)) {
    return fullChat;
  }

  const boundaryId = compaction.previousSummaryFirstKeptMessageId ?? null;
  const boundaryIndex = boundaryId ? history.findIndex((r) => r.id === boundaryId) : -1;
  const startIndex = boundaryIndex >= 0 ? boundaryIndex : 0;

  const cut = findTurnCutPoint(history, compaction.keepRecentTokens, startIndex);
  if (!cut) {
    return fullChat;
  }

  const rowsToSummarize = history.slice(startIndex, cut.index);
  const summarizationClient = client as unknown as SummarizationClient;

  try {
    const { summary, usage } = await summarize(
      summarizationClient,
      rowsToSummarize,
      compaction.previousSummary,
      env.openaiModel
    );

    if (compaction.onCompaction) {
      try {
        await compaction.onCompaction({
          summary,
          firstKeptMessageId: cut.rowId,
          tokensBefore: estimateMessagesTokens(fullChat),
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        });
      } catch (err) {
        console.error("[tool-loop] onCompaction persistence failed", err);
      }
    }

    const summaryMessage: ChatMessage = {
      role: "system",
      content: `Checkpoint summary of the earlier conversation:\n${summary}`,
    };
    const keptRows = history.slice(cut.index);
    return [systemMessage, summaryMessage, ...keptRows.map(rowToChatMessage)];
  } catch (err) {
    console.error("[tool-loop] pre-turn compaction failed, continuing uncompacted", err);
    return fullChat;
  }
}

/**
 * Mid-loop split-turn compaction: called at the top of every iteration.
 * Tool results appended by earlier iterations can push a single still-open
 * turn over budget on its own - split it by summarizing the turn's prefix
 * (up to but not including the most recent assistant message that keeps us
 * under budget) and splicing that summary in place of the prefix. This is
 * loop-local: never persisted, since the next turn's pre-turn compaction
 * re-summarizes the full span from the last durable boundary anyway.
 */
async function maybeSplitTurn(
  messages: ChatMessage[],
  client: ChatCompletionsClient,
  compaction: CompactionRuntimeOptions
): Promise<ChatMessage[]> {
  if (!shouldCompact(messages, compaction.thresholdTokens)) {
    return messages;
  }

  const turnStartIndex = findLastUserIndex(messages);
  if (turnStartIndex < 0) return messages;

  const cut = findAssistantCutPoint(messages, turnStartIndex, compaction.keepRecentTokens);
  if (!cut) return messages;

  const hasExistingSummary = messages.length > 1 && messages[1].role === "system";
  const keepPrefixCount = hasExistingSummary ? 2 : 1;
  const prefixMessages = messages.slice(turnStartIndex, cut.index);
  const summarizationClient = client as unknown as SummarizationClient;

  try {
    const { summary } = await summarizeTurnPrefix(summarizationClient, prefixMessages, env.openaiModel);
    const turnSummaryMessage: ChatMessage = {
      role: "system",
      content: `Turn context checkpoint (earlier part of this turn was summarized):\n${summary}`,
    };
    return applyCompaction(messages, cut.index, turnSummaryMessage, keepPrefixCount);
  } catch (err) {
    console.error("[tool-loop] mid-loop split-turn compaction failed, continuing uncompacted", err);
    return messages;
  }
}

async function runLoopBody(
  history: Message[],
  onToken: (token: string) => void,
  onToolEvent: ((event: ToolEvent) => void) | undefined,
  tools: Tool[],
  client: ChatCompletionsClient,
  maxIterations: number,
  compaction: CompactionRuntimeOptions | undefined
): Promise<RunLoopResult> {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  let messages: ChatMessage[];
  if (compaction?.enabled) {
    // Compaction owns the budget - the row-count window above is bypassed
    // and the full history feeds the compaction pass instead.
    messages = await buildCompactedMessages(history, client, compaction);
  } else {
    const recent = sliceHistoryAtTurnBoundaries(
      history,
      // TOOL_LOOP_HISTORY_LIMIT=0 disables the window: pass the full history
      // (length as limit short-circuits the slice to a no-op). Default 20 rows.
      env.toolLoopHistoryLimit > 0 ? env.toolLoopHistoryLimit : history.length
    );
    messages = [{ role: "system", content: SYSTEM_PROMPT }, ...recent.map(rowToChatMessage)];
  }

  let lastAssistantText = "";
  const toolExchange: ToolExchangeRecord[] = [];

  let usageSeen = false;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalStreamMs = 0;
  let totalFirstTokenMs = 0;

  const buildUsage = (): RunLoopUsage | null =>
    usageSeen
      ? {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          streamMs: totalStreamMs,
          firstTokenMs: totalFirstTokenMs,
        }
      : null;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (compaction?.enabled) {
      messages = await maybeSplitTurn(messages, client, compaction);
    }

    const startMs = Date.now();
    const stream = await client.chat.completions.create({
      model: env.openaiModel,
      messages,
      tools: toolDefs,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
    });

    let text = "";
    // Streamed tool-call deltas arrive keyed by their eventual array index,
    // not appended in order - accumulate by index, not by arrival order.
    const toolCallsByIndex = new Map<number, AccumulatedToolCall>();
    let finishReason: string | null = null;
    let firstTokenMs: number | null = null;

    for await (const chunk of stream) {
      // Usage may arrive on a chunk with empty `choices` (e.g. the final
      // usage-only chunk DeepSeek sends with stream_options.include_usage) -
      // read it before the choices?.[0] continue-check below, or it's
      // silently dropped.
      if (chunk.usage) {
        usageSeen = true;
        totalPromptTokens += chunk.usage.prompt_tokens ?? 0;
        totalCompletionTokens += chunk.usage.completion_tokens ?? 0;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) {
        if (firstTokenMs === null) firstTokenMs = Date.now();
        text += delta.content;
        onToken(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let entry = toolCallsByIndex.get(tc.index);
          if (!entry) {
            entry = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
            toolCallsByIndex.set(tc.index, entry);
          } else {
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
          }
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const endMs = Date.now();
    totalStreamMs += endMs - startMs;
    if (firstTokenMs !== null) totalFirstTokenMs += firstTokenMs - startMs;

    const toolCalls = Array.from(toolCallsByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);

    if (toolCalls.length === 0) {
      return { content: text, toolExchange, usage: buildUsage() };
    }
    if (text) lastAssistantText = text;

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    if (finishReason === "length") {
      // Truncated mid-tool-call: args may be incomplete, so don't execute -
      // fail the pending calls and let the model retry with more room.
      for (const tc of toolCalls) {
        onToolEvent?.({ type: "tool_start", toolCallId: tc.id, toolName: tc.name });
        onToolEvent?.({ type: "tool_end", toolCallId: tc.id, toolName: tc.name, isError: true });
        const content =
          "Error: response was truncated before this tool call completed. Please retry with a smaller request.";
        messages.push({ role: "tool", tool_call_id: tc.id, content });
        toolExchange.push({
          iteration,
          toolCallId: tc.id,
          toolName: tc.name,
          arguments: tc.arguments,
          args: tryParseArgsForEvent(tc.arguments),
          result: content,
          isError: true,
        });
      }
      continue;
    }

    for (const tc of toolCalls) {
      const args = tryParseArgsForEvent(tc.arguments);
      onToolEvent?.({ type: "tool_start", toolCallId: tc.id, toolName: tc.name, args });
      const result = await executeToolCall(tc, toolsByName);
      onToolEvent?.({
        type: "tool_end",
        toolCallId: tc.id,
        toolName: tc.name,
        isError: result.isError,
      });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result.content });
      toolExchange.push({
        iteration,
        toolCallId: tc.id,
        toolName: tc.name,
        arguments: tc.arguments,
        args,
        result: result.content,
        isError: result.isError,
      });
    }
  }

  console.warn(
    `[tool-loop] hit max iterations (${maxIterations}) without a final answer - ` +
      `returning ${lastAssistantText ? "the last partial answer" : "the fallback message"}`
  );
  return { content: lastAssistantText || FALLBACK_MESSAGE, toolExchange, usage: buildUsage() };
}

export async function runToolLoop(
  history: Message[],
  onToken: (token: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
  options: ToolLoopOptions = {}
): Promise<RunLoopResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tools = options.tools ?? DEFAULT_TOOLS;
  const client = options.client ?? getDefaultClient();

  let timeoutHandle: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Tool loop timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      runLoopBody(history, onToken, onToolEvent, tools, client, maxIterations, options.compaction),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}
