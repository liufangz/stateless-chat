import OpenAI from "openai";
import { env } from "@stateless-chat/shared";
import type { Message, ToolExchangeRecord } from "@stateless-chat/shared";
import { DEFAULT_TOOLS } from "./tools/index.js";
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
const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_TIMEOUT_MS = 300_000;
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

export interface ChatCompletionChunkLike {
  choices: ChatCompletionChunkChoice[];
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

export interface ToolLoopOptions {
  client?: ChatCompletionsClient;
  tools?: Tool[];
  maxIterations?: number;
  timeoutMs?: number;
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

export interface RunLoopResult {
  content: string;
  toolExchange: ToolExchangeRecord[];
}

async function runLoopBody(
  history: Message[],
  onToken: (token: string) => void,
  onToolEvent: ((event: ToolEvent) => void) | undefined,
  tools: Tool[],
  client: ChatCompletionsClient,
  maxIterations: number
): Promise<RunLoopResult> {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const recent = sliceHistoryAtTurnBoundaries(history, HISTORY_LIMIT);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...recent.map(rowToChatMessage),
  ];

  let lastAssistantText = "";
  const toolExchange: ToolExchangeRecord[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const stream = await client.chat.completions.create({
      model: env.openaiModel,
      messages,
      tools: toolDefs,
      tool_choice: "auto",
      stream: true,
    });

    let text = "";
    // Streamed tool-call deltas arrive keyed by their eventual array index,
    // not appended in order - accumulate by index, not by arrival order.
    const toolCallsByIndex = new Map<number, AccumulatedToolCall>();
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) {
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

    const toolCalls = Array.from(toolCallsByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);

    if (toolCalls.length === 0) {
      return { content: text, toolExchange };
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
  return { content: lastAssistantText || FALLBACK_MESSAGE, toolExchange };
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
      runLoopBody(history, onToken, onToolEvent, tools, client, maxIterations),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}
