import OpenAI from "openai";
import { env, SYSTEM_PROMPT } from "@stateless-chat/shared";
import type { Message, ToolExchangeRecord } from "@stateless-chat/shared";
import { DEFAULT_TOOLS } from "./tools/index.js";
import { createSubagentTool, SUBAGENT_TOOL_NAME } from "./tools/subagent.js";
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
import type { CompactableMessage, SummarizationClient } from "./compaction.js";
import type { Lifecycle, LifecycleHooks, LifecycleMessage } from "./lifecycle.js";
export { DEFAULT_TOOLS } from "./tools/index.js";
export { createSubagentTool, SUBAGENT_TOOL_NAME } from "./tools/subagent.js";
export type { SubagentToolOptions } from "./tools/subagent.js";
export type { ToolExchangeRecord } from "@stateless-chat/shared";
export type { AgentEvent, Lifecycle, LifecycleHooks, LifecycleMessage } from "./lifecycle.js";

// SYSTEM_PROMPT now lives in packages/shared/src/context-estimate.ts (moved
// verbatim, byte-for-byte identical) so the gateway's historical
// context-occupation fallback can count the exact same system prompt this
// worker actually sends - see estimateHistoricalContextTokens there.

export const HISTORY_LIMIT = 20;
// No iteration cap. It used to exist only to bound context growth before
// compaction (see maybeSplitTurn below) existed - compaction now owns that,
// and the wall-clock deadline below is what stops a loop that never stops
// calling tools: the per-iteration deadline check in runLoopBody guarantees
// the loop exits within timeoutMs regardless of how many rounds it took, so
// a separate round-count fuse adds no protection an iteration count can't
// already provide more precisely. When the deadline trips, the loop takes
// the answer-now retry path, never a direct fallback. Timeout history:
// 300s/20 iterations -> 600s/50 on 2026-08-27 at liufangz's request -> no
// iteration cap at all on 2026-08-30.
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
  /**
   * Phase 3 crash-recovery policy: whether this tool is safe to
   * automatically re-execute after a worker crashes between issuing the
   * call and persisting its result. Read-only tools (no external side
   * effect) are safe to retry blind. Anything that can mutate host state
   * (bash, file writes) MUST leave this unset/false - a crash in that
   * window means the side effect may or may not have already happened, and
   * database idempotency alone can't tell us which. Unset defaults to
   * "not safe to retry", the conservative choice for an unknown tool.
   */
  readOnly?: boolean;
}

export type ToolEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean };

export interface CompactionEntry {
  summary: string;
  firstKeptMessageId: string;
  /** id of the first row included in the summarized span (Phase 4 durable
   * compaction source boundary). */
  sourceStartMessageId: string;
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

/**
 * Phase 3 durable per-step persistence hooks. Both are awaited inline in
 * the loop - the loop does not proceed past the point that would make a
 * skipped/failed persist unrecoverable:
 *   - onToolCallRequest fires with one iteration's full set of calls BEFORE
 *     any of them execute. This is the durable "the model asked for this"
 *     record.
 *   - onToolResult fires once per call, immediately after that call's
 *     result is known (executed, or synthetically failed e.g. by a
 *     finish_reason==='length' truncation), before the next call executes
 *     or the next LLM continuation is requested.
 * Either callback may throw (e.g. because the caller's ownership/lease
 * check found this worker no longer owns the turn) - runToolLoop does not
 * catch that, so it propagates out of the loop and the turn is abandoned
 * without further execution or persistence.
 */
export interface ToolLoopPersistence {
  onToolCallRequest: (
    iteration: number,
    calls: { toolCallId: string; toolName: string; arguments: string }[]
  ) => Promise<void>;
  onToolResult: (record: ToolExchangeRecord) => Promise<void>;
}

export interface ToolLoopOptions {
  client?: ChatCompletionsClient;
  tools?: Tool[];
  timeoutMs?: number;
  compaction?: CompactionRuntimeOptions;
  /**
   * Durable per-step persistence (Phase 3). Omitted entirely by tests that
   * don't care about persistence.
   */
  persistence?: ToolLoopPersistence;
  /**
   * First `iteration` number this invocation should use/persist, so a
   * resumed turn's newly-issued requests don't collide with iterations a
   * previous attempt already committed. Does NOT change how long *this*
   * invocation is allowed to run (`timeoutMs` is still a per-invocation
   * wall-clock budget, not a lifetime one) - only the numbering used for
   * the durable `iteration` column and idempotency key. Defaults to 0 (a
   * fresh turn).
   */
  startIteration?: number;
  /**
   * pi-style lifecycle event registry. The loop emits turn_start/turn_end,
   * message_start/message_update/message_end (assistant text + tool
   * results), and tool_execution_start/end through it. Listeners are
   * awaited in subscription order and a throwing listener aborts the turn,
   * exactly like pi's Agent.subscribe. Purely additive - omit for the old
   * behavior.
   */
  lifecycle?: Lifecycle;
  /**
   * pi-style decision hooks. Can veto/patch tool calls
   * (beforeToolCall/afterToolCall), stop the loop early
   * (shouldStopAfterTurn), and inject context before an iteration
   * (prepareNextTurn). Optional and purely additive.
   */
  hooks?: LifecycleHooks;
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

/**
 * Per-run default tool assembly: DEFAULT_TOOLS with the static subagent
 * replaced by one bound to THIS run's client, lifecycle (so child events and
 * progress stream through the parent's lifecycle -> SSE), and a timeout that
 * is a slice of the parent's remaining budget (leaving headroom for the
 * parent's own answer-now wrap-up). When the caller passes `options.tools`
 * explicitly (e.g. a nested subagent's allowlist), this is bypassed entirely
 * and no re-binding happens.
 */
function buildRunTools(
  client: ChatCompletionsClient,
  lifecycle: Lifecycle | undefined,
  timeoutMs: number
): Tool[] {
  return DEFAULT_TOOLS.map((t) =>
    t.name === SUBAGENT_TOOL_NAME
      ? createSubagentTool({
          client,
          lifecycle,
          timeoutMs: Math.max(30_000, Math.floor(timeoutMs * 0.7)),
        })
      : t
  );
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

/**
 * Executes one tool call, translating a missing tool, malformed JSON args,
 * or a thrown error into a `{ isError: true }` result instead of letting
 * any of those reject the caller - exported so the Phase 3 turn-recovery
 * path (packages/worker/src/turn-recovery.ts) can re-run a pending
 * read-only call with identical semantics to the main loop.
 */
export async function executeToolCall(
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

/**
 * Converts a pi-style lifecycle message back into the loop's internal
 * ChatMessage shape. Used by the prepareNextTurn hook to inject context
 * before an iteration.
 */
export function lifecycleMessageToChatMessage(m: LifecycleMessage): ChatMessage {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: m.role as "user" | "assistant", content: m.content };
}

/** Snapshot of the loop's internal messages for hook/prepareNextTurn context. */
function chatMessagesToLifecycle(messages: ChatMessage[]): LifecycleMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, toolCallId: m.tool_call_id ?? undefined };
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: null,
        toolCalls: m.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
      };
    }
    return { role: m.role === "system" ? "user" : m.role, content: m.content };
  });
}

export interface RunLoopUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  streamMs: number;
  firstTokenMs: number;
  /**
   * Context occupation: the prompt size of the LAST LLM call this turn
   * made (provider-reported when that round's stream carried a usage
   * chunk, otherwise a conservative local estimate of the messages array
   * actually sent - see estimateMessagesTokens in compaction.ts). This is
   * what's actually sent as context for the next turn - unlike
   * promptTokens/totalTokens above, it is NOT summed across a tool-heavy
   * turn's many round-trips.
   */
  contextTokens: number;
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

    // A blank summary is a failed compaction, not a usable one - never
    // persist it and never splice it into context (it would just be a
    // useless "Checkpoint summary:" header with nothing under it). Falling
    // back to fullChat leaves raw history untouched and fully usable; the
    // console.error makes the failure diagnosable without crashing the turn
    // (compaction is a budget optimization, never a hard requirement).
    if (!summary || summary.trim().length === 0) {
      console.error(
        "[tool-loop] pre-turn compaction summarization returned an empty summary - " +
          "skipping persistence, continuing uncompacted"
      );
      return fullChat;
    }

    if (compaction.onCompaction) {
      try {
        await compaction.onCompaction({
          summary,
          firstKeptMessageId: cut.rowId,
          sourceStartMessageId: history[startIndex].id,
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
    // Same "blank summary = failed compaction" rule as the pre-turn path -
    // splicing an empty checkpoint into context would just drop the prefix
    // with nothing replacing it. Not persisted either way (mid-loop splits
    // are loop-local), so falling back to the unmodified messages is the
    // only guard needed here.
    if (!summary || summary.trim().length === 0) {
      console.error(
        "[tool-loop] mid-loop split-turn summarization returned an empty summary - " +
          "skipping split, continuing unsplit"
      );
      return messages;
    }
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
  timeoutMs: number,
  compaction: CompactionRuntimeOptions | undefined,
  persistence: ToolLoopPersistence | undefined,
  startIteration: number,
  aborted: { value: boolean },
  lifecycle: Lifecycle | undefined,
  hooks: LifecycleHooks | undefined
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
  // Context occupation (RunLoopUsage.contextTokens): overwritten (not
  // accumulated) after every LLM call, so it always describes only the MOST
  // RECENT call. Kept as cheap raw inputs (a number + a message-array
  // reference) rather than an eagerly-computed estimate, so a round whose
  // stream DID report usage costs nothing extra, and the (rare) fallback
  // estimate is only ever computed on demand in buildUsage() below - never
  // unconditionally on every round of the hot loop.
  let latestRoundPromptTokens: number | null = null;
  let latestRoundMessages: ChatMessage[] = [];

  const buildUsage = (): RunLoopUsage | null =>
    usageSeen
      ? {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          streamMs: totalStreamMs,
          firstTokenMs: totalFirstTokenMs,
          contextTokens:
            latestRoundPromptTokens ??
            estimateMessagesTokens(latestRoundMessages as unknown as CompactableMessage[]),
        }
      : null;

  const deadline = Date.now() + timeoutMs;

  // Returned once `aborted.value` is observed true. By the time that
  // happens, runToolLoop's Promise.race has already settled on the backstop
  // rejection, so this value itself is never read - what matters is that
  // returning here stops the loop from making another LLM call or touching
  // persistence/publish for a turn this invocation has already given up on.
  const abortedResult = (): RunLoopResult => ({
    content: lastAssistantText || FALLBACK_MESSAGE,
    toolExchange,
    usage: buildUsage(),
  });

  for (let round = 0; ; round++) {
    // `iteration` is the durable, cross-restart identifier persisted on the
    // tool-call-request row (and used as its idempotency key); `round` is
    // just this invocation's local loop counter, unbounded except by the
    // wall-clock deadline below - see ToolLoopOptions.startIteration.
    const iteration = startIteration + round;
    if (aborted.value) return abortedResult();
    if (Date.now() > deadline) {
      break;
    }

    // pi-style decision hooks, both checked from the second iteration on
    // (the first iteration always runs so the model gets its first say):
    //   - shouldStopAfterTurn: stop the tool loop early and route through
    //     the answer-now wrap-up below (model answers from gathered info,
    //     no further tool calls).
    //   - prepareNextTurn: inject extra context messages before the model
    //     is called again.
    if (round > 0) {
      if (hooks?.shouldStopAfterTurn) {
        const stop = await hooks.shouldStopAfterTurn({
          iteration,
          lastAssistantText,
          toolExchange,
        });
        if (stop) {
          console.warn(
            `[tool-loop] shouldStopAfterTurn hook stopped the loop at iteration ${iteration} - wrapping up`
          );
          break;
        }
      }
      if (hooks?.prepareNextTurn) {
        const injected = await hooks.prepareNextTurn({
          iteration,
          nextIteration: iteration + 1,
          messages: chatMessagesToLifecycle(messages),
        });
        if (injected && injected.length > 0) {
          messages.push(...injected.map(lifecycleMessageToChatMessage));
        }
      }
    }

    if (compaction?.enabled) {
      messages = await maybeSplitTurn(messages, client, compaction);
    }

    let roundPromptTokens = 0;
    let roundUsageSeen = false;

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
    // Emit tool_start the moment a tool call's id+name arrive in the stream,
    // so the client renders a running chip immediately instead of looking
    // stuck during a tool-only stream. The pre-execution tool_start below
    // (with full args) may fire again - clients upsert by toolCallId.
    const emittedToolStart = new Set<string>();
    let finishReason: string | null = null;
    let firstTokenMs: number | null = null;

    // pi-style message lifecycle for this iteration's assistant message.
    // message_start fires on the first content or tool-call delta, then
    // message_update per text delta, then message_end once the stream is
    // fully assembled (full text + tool calls known).
    let assistantMsgStarted = false;
    const assistantLifecycleMessage = (content: string | null): LifecycleMessage => ({
      role: "assistant",
      content,
      toolCalls: Array.from(toolCallsByIndex.values())
        .filter((tc) => tc.id)
        .map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
    });

    const maybeEmitToolStart = (tc: { id: string; name: string }) => {
      if (tc.id && tc.name && !emittedToolStart.has(tc.id)) {
        emittedToolStart.add(tc.id);
        onToolEvent?.({ type: "tool_start", toolCallId: tc.id, toolName: tc.name });
      }
    };

    for await (const chunk of stream) {
      // Usage may arrive on a chunk with empty `choices` (e.g. the final
      // usage-only chunk DeepSeek sends with stream_options.include_usage) -
      // read it before the choices?.[0] continue-check below, or it's
      // silently dropped.
      if (chunk.usage) {
        usageSeen = true;
        roundUsageSeen = true;
        totalPromptTokens += chunk.usage.prompt_tokens ?? 0;
        totalCompletionTokens += chunk.usage.completion_tokens ?? 0;
        roundPromptTokens += chunk.usage.prompt_tokens ?? 0;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) {
        if (firstTokenMs === null) firstTokenMs = Date.now();
        if (!assistantMsgStarted) {
          assistantMsgStarted = true;
          await lifecycle?.emit({ type: "message_start", message: assistantLifecycleMessage("") });
        }
        text += delta.content;
        onToken(delta.content);
        await lifecycle?.emit({
          type: "message_update",
          message: assistantLifecycleMessage(text),
          contentDelta: delta.content,
        });
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
          // Emit message_start after the entry is registered, so the
          // message already carries the tool call that triggered it.
          if (!assistantMsgStarted) {
            assistantMsgStarted = true;
            await lifecycle?.emit({ type: "message_start", message: assistantLifecycleMessage(null) });
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const endMs = Date.now();
    totalStreamMs += endMs - startMs;
    if (firstTokenMs !== null) totalFirstTokenMs += firstTokenMs - startMs;
    // Cheap capture only - the fallback estimate (if needed) is computed
    // lazily in buildUsage(), not here on every round. A shallow slice()
    // (pointer copy, not the token-counting scan) so a later push()
    // mutating `messages` in place can't retroactively grow this snapshot
    // out from under an eventual estimateMessagesTokens call.
    latestRoundPromptTokens = roundUsageSeen ? roundPromptTokens : null;
    latestRoundMessages = messages.slice();

    const toolCalls = Array.from(toolCallsByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);

    // The iteration's assistant message is complete now: emit message_end
    // with the full assembled text and tool calls (also covers tool-only
    // iterations, where message_start already fired on the first tool-call
    // delta). A `text`-only early return below still gets this event.
    if (assistantMsgStarted) {
      await lifecycle?.emit({ type: "message_end", message: assistantLifecycleMessage(text || null) });
    }

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

    // The stream read above is the one await in this iteration long enough
    // for the backstop to have tripped while we were inside it - check
    // before touching persistence at all, not just at the top of the loop.
    if (aborted.value) return abortedResult();

    // Durable checkpoint #1 (Phase 3): the model's tool-call request is
    // persisted BEFORE any of its calls execute. If this throws (e.g. the
    // caller's lease/ownership check found this worker no longer owns the
    // turn), the loop aborts here - nothing below has run yet, so there is
    // nothing to roll back.
    await persistence?.onToolCallRequest(
      iteration,
      toolCalls.map((tc) => ({ toolCallId: tc.id, toolName: tc.name, arguments: tc.arguments }))
    );

    if (finishReason === "length") {
      // Truncated mid-tool-call: args may be incomplete, so don't execute -
      // fail the pending calls and let the model retry with more room.
      for (const tc of toolCalls) {
        onToolEvent?.({ type: "tool_start", toolCallId: tc.id, toolName: tc.name });
        onToolEvent?.({ type: "tool_end", toolCallId: tc.id, toolName: tc.name, isError: true });
        const content =
          "Error: response was truncated before this tool call completed. Please retry with a smaller request.";
        const args = tryParseArgsForEvent(tc.arguments);
        await lifecycle?.emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args });
        await lifecycle?.emit({
          type: "tool_execution_end",
          toolCallId: tc.id,
          toolName: tc.name,
          result: content,
          isError: true,
        });
        const toolMsg: LifecycleMessage = { role: "tool", content, toolCallId: tc.id };
        await lifecycle?.emit({ type: "message_start", message: toolMsg });
        await lifecycle?.emit({ type: "message_end", message: toolMsg });
        const record: ToolExchangeRecord = {
          iteration,
          toolCallId: tc.id,
          toolName: tc.name,
          arguments: tc.arguments,
          args,
          result: content,
          isError: true,
        };
        // Durable checkpoint #2: result persisted before the next
        // iteration's LLM continuation. No real execution happened here
        // (truncated calls are never run), so there's no crash-window
        // ambiguity to worry about for this one.
        if (aborted.value) return abortedResult();
        await persistence?.onToolResult(record);
        messages.push({ role: "tool", tool_call_id: tc.id, content });
        toolExchange.push(record);
      }
      continue;
    }

    for (const tc of toolCalls) {
      const args = tryParseArgsForEvent(tc.arguments);
      onToolEvent?.({ type: "tool_start", toolCallId: tc.id, toolName: tc.name, args });
      await lifecycle?.emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args });

      // pi-style beforeToolCall: veto the call or patch its arguments
      // before execution. A veto fails the call without running it.
      let execArgs: unknown = args;
      let vetoed = false;
      let vetoReason = "";
      const before = await hooks?.beforeToolCall?.({ toolCallId: tc.id, toolName: tc.name, args });
      if (before?.stop) {
        vetoed = true;
        vetoReason = before.reason ?? `tool call stopped by beforeToolCall hook`;
      } else if (before?.args !== undefined) {
        execArgs = before.args;
      }

      let result: ToolExecutionResult = vetoed
        ? { content: `Error: ${vetoReason}`, isError: true }
        : before?.args !== undefined
          ? await executeToolCall({ ...tc, arguments: JSON.stringify(execArgs ?? {}) }, toolsByName)
          : await executeToolCall(tc, toolsByName);

      // pi-style afterToolCall: patch the result the model sees.
      const after =
        vetoed || result.isError
          ? undefined
          : await hooks?.afterToolCall?.({
              toolCallId: tc.id,
              toolName: tc.name,
              args: execArgs,
              result: result.content,
              isError: result.isError,
            });
      if (after?.result !== undefined) {
        result = { content: after.result, isError: result.isError };
      }

      onToolEvent?.({
        type: "tool_end",
        toolCallId: tc.id,
        toolName: tc.name,
        isError: result.isError,
      });
      await lifecycle?.emit({
        type: "tool_execution_end",
        toolCallId: tc.id,
        toolName: tc.name,
        result: result.content,
        isError: result.isError,
      });
      const toolMsg: LifecycleMessage = { role: "tool", content: result.content, toolCallId: tc.id };
      await lifecycle?.emit({ type: "message_start", message: toolMsg });
      await lifecycle?.emit({ type: "message_end", message: toolMsg });
      const record: ToolExchangeRecord = {
        iteration,
        toolCallId: tc.id,
        toolName: tc.name,
        arguments: tc.arguments,
        args: execArgs,
        result: result.content,
        isError: result.isError,
      };
      // Durable checkpoint #2: result persisted immediately after
      // execution, before the next tool call executes or the next LLM
      // continuation is requested. If a crash happens between
      // executeToolCall returning and this persisting, a mutating tool's
      // side effect may have already happened with no durable record of
      // it - see turn-recovery.ts, which is what has to reason about that
      // window on the next claim.
      //
      // executeToolCall above is the other long single await a stuck tool
      // (e.g. a hung bash command) can sit inside past the backstop -
      // recheck here before writing anything for the same reason as the
      // check after the stream read.
      if (aborted.value) return abortedResult();
      await persistence?.onToolResult(record);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result.content });
      toolExchange.push(record);
    }
  }

  console.warn(
    `[tool-loop] hit wall-clock deadline (${timeoutMs}ms) without a final answer - issuing an answer-now retry`
  );

  // pi's compact-and-retry analog: one final call, no tools, telling the
  // model to answer from whatever was gathered instead of continuing to
  // reach for more tools it no longer has budget for.
  if (aborted.value) return abortedResult();
  try {
    const retryMessages: ChatMessage[] = [
      ...messages,
      {
        role: "user",
        content:
          "Tool budget exhausted. Answer the user's original question now, using only the " +
          "information gathered above. Do not call any tools.",
      },
    ];

    let retryPromptTokens = 0;
    let retryUsageSeen = false;

    const retryStartMs = Date.now();
    const retryStream = await client.chat.completions.create({
      model: env.openaiModel,
      messages: retryMessages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let retryText = "";
    let retryFirstTokenMs: number | null = null;
    // The answer-now retry is a real assistant message too - surface it
    // through the same message lifecycle as a normal iteration.
    let retryMsgStarted = false;
    for await (const chunk of retryStream) {
      if (chunk.usage) {
        usageSeen = true;
        retryUsageSeen = true;
        totalPromptTokens += chunk.usage.prompt_tokens ?? 0;
        totalCompletionTokens += chunk.usage.completion_tokens ?? 0;
        retryPromptTokens += chunk.usage.prompt_tokens ?? 0;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) {
        if (retryFirstTokenMs === null) retryFirstTokenMs = Date.now();
        if (!retryMsgStarted) {
          retryMsgStarted = true;
          await lifecycle?.emit({ type: "message_start", message: { role: "assistant", content: "" } });
        }
        retryText += delta.content;
        onToken(delta.content);
        await lifecycle?.emit({
          type: "message_update",
          message: { role: "assistant", content: retryText },
          contentDelta: delta.content,
        });
      }
    }
    const retryEndMs = Date.now();
    totalStreamMs += retryEndMs - retryStartMs;
    if (retryFirstTokenMs !== null) totalFirstTokenMs += retryFirstTokenMs - retryStartMs;
    // retryMessages is a fresh array (built via spread above) never mutated
    // again, so - unlike the main loop's `messages` - no snapshot is needed.
    latestRoundPromptTokens = retryUsageSeen ? retryPromptTokens : null;
    latestRoundMessages = retryMessages;

    if (retryText) {
      if (retryMsgStarted) {
        await lifecycle?.emit({ type: "message_end", message: { role: "assistant", content: retryText } });
      }
      return { content: retryText, toolExchange, usage: buildUsage() };
    }
    console.warn("[tool-loop] answer-now retry returned no text - falling back");
  } catch (err) {
    console.warn("[tool-loop] answer-now retry failed - falling back", err);
  }

  return { content: lastAssistantText || FALLBACK_MESSAGE, toolExchange, usage: buildUsage() };
}

export async function runToolLoop(
  history: Message[],
  onToken: (token: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
  options: ToolLoopOptions = {}
): Promise<RunLoopResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = options.client ?? getDefaultClient();
  const lifecycle = options.lifecycle;
  const hooks = options.hooks;
  const tools = options.tools ?? buildRunTools(client, lifecycle, timeoutMs);

  // Pure backstop, not the primary exit path anymore: the loop itself exits
  // gracefully at `timeoutMs` (checked per-iteration in runLoopBody) and
  // runs the answer-now retry, which needs its own headroom to complete.
  // This only fires for a truly stuck call (e.g. a hung tool execution)
  // that the per-iteration deadline check can't preempt mid-await.
  const backstopMs = timeoutMs + 120_000;
  // Promise.race doesn't cancel the loser - runLoopBody keeps running
  // in the background after this fires (nothing here can interrupt an
  // in-flight LLM stream read or tool execution). `aborted` is how the loop
  // finds out it lost the race, checked before every persistence write and
  // before starting another LLM call, so a turn already reported as failed
  // (by whoever is awaiting this call) can't still write tool-call rows or
  // spend more tokens once it resumes from whatever it was stuck awaiting.
  const aborted = { value: false };
  let timeoutHandle: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      aborted.value = true;
      reject(new Error(`Tool loop timed out after ${backstopMs}ms`));
    }, backstopMs);
  });

  // pi-style turn lifecycle: turn_start before anything runs, turn_end once
  // the final message and all tool results are in (only on a normal
  // completion - an aborted/timed-out turn rejects and never emits turn_end,
  // matching pi's failed-run semantics).
  await lifecycle?.emit({ type: "turn_start" });
  try {
    const result = await Promise.race([
      runLoopBody(
        history,
        onToken,
        onToolEvent,
        tools,
        client,
        timeoutMs,
        options.compaction,
        options.persistence,
        options.startIteration ?? 0,
        aborted,
        lifecycle,
        hooks
      ),
      timeout,
    ]);
    await lifecycle?.emit({
      type: "turn_end",
      message: { role: "assistant", content: result.content },
      toolResults: result.toolExchange,
    });
    return result;
  } finally {
    clearTimeout(timeoutHandle!);
  }
}
