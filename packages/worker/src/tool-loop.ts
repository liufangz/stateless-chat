import OpenAI from "openai";
import { env } from "@stateless-chat/shared";
import type { Message } from "@stateless-chat/shared";

const SYSTEM_PROMPT =
  "You are a helpful, concise assistant in a chat application. Keep replies short. " +
  "Use the available tools when they would make your answer more accurate (e.g. exact " +
  "date/time or arithmetic) instead of guessing.";

const HISTORY_LIMIT = 20;
const DEFAULT_MAX_ITERATIONS = 6;
const DEFAULT_TIMEOUT_MS = 60_000;
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

// --- Tools -------------------------------------------------------------

const getCurrentDatetimeTool: Tool = {
  name: "get_current_datetime",
  description:
    "Get the current date and time, optionally formatted for a specific IANA timezone.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description:
          "IANA timezone name, e.g. 'America/New_York'. Defaults to UTC when omitted.",
      },
    },
    required: [],
  },
  execute(args: unknown): string {
    const { timezone } = (args ?? {}) as { timezone?: unknown };
    const now = new Date();
    if (typeof timezone === "string" && timezone.trim() !== "") {
      try {
        return new Intl.DateTimeFormat("en-US", {
          dateStyle: "full",
          timeStyle: "long",
          timeZone: timezone,
        }).format(now);
      } catch {
        throw new Error(`Invalid timezone '${timezone}'`);
      }
    }
    return now.toISOString();
  },
};

const calculatorTool: Tool = {
  name: "calculator",
  description:
    "Evaluate a basic arithmetic expression. Supports + - * / ^ (power), sqrt(), and parentheses.",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "Arithmetic expression, e.g. '(2 + 3) * 4' or 'sqrt(16)'",
      },
    },
    required: ["expression"],
  },
  execute(args: unknown): string {
    const { expression } = (args ?? {}) as { expression?: unknown };
    if (typeof expression !== "string" || expression.trim() === "") {
      throw new Error("calculator requires a non-empty 'expression' string");
    }
    return String(evaluateExpression(expression));
  },
};

export const DEFAULT_TOOLS: Tool[] = [getCurrentDatetimeTool, calculatorTool];

// --- Calculator: self-contained recursive-descent parser --------------
// Never eval()/new Function() on model-supplied strings — args are LLM
// output and could carry a prompt-injection payload.

type TokenType =
  | "number"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "caret"
  | "lparen"
  | "rparen"
  | "ident"
  | "eof";

interface Token {
  type: TokenType;
  value: string;
}

function tokenizeExpression(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const start = i;
      while (i < input.length && /[0-9.]/.test(input[i])) i++;
      tokens.push({ type: "number", value: input.slice(start, i) });
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      const start = i;
      while (i < input.length && /[a-zA-Z]/.test(input[i])) i++;
      tokens.push({ type: "ident", value: input.slice(start, i) });
      continue;
    }
    const single: Partial<Record<string, TokenType>> = {
      "+": "plus",
      "-": "minus",
      "*": "star",
      "/": "slash",
      "^": "caret",
      "(": "lparen",
      ")": "rparen",
    };
    const type = single[c];
    if (!type) {
      throw new Error(`Unexpected character '${c}' in expression`);
    }
    tokens.push({ type, value: c });
    i++;
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class ExpressionParser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType): Token {
    const t = this.advance();
    if (t.type !== type) {
      throw new Error(`Expected '${type}' but got '${t.value || t.type}'`);
    }
    return t;
  }

  parse(): number {
    const value = this.parseExpression();
    this.expect("eof");
    return value;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    while (this.peek().type === "plus" || this.peek().type === "minus") {
      const op = this.advance();
      const rhs = this.parseTerm();
      value = op.type === "plus" ? value + rhs : value - rhs;
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parsePower();
    while (this.peek().type === "star" || this.peek().type === "slash") {
      const op = this.advance();
      const rhs = this.parsePower();
      if (op.type === "slash") {
        if (rhs === 0) throw new Error("Division by zero");
        value = value / rhs;
      } else {
        value = value * rhs;
      }
    }
    return value;
  }

  private parsePower(): number {
    const base = this.parseUnary();
    if (this.peek().type === "caret") {
      this.advance();
      return Math.pow(base, this.parsePower()); // right-associative
    }
    return base;
  }

  private parseUnary(): number {
    if (this.peek().type === "plus") {
      this.advance();
      return this.parseUnary();
    }
    if (this.peek().type === "minus") {
      this.advance();
      return -this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const t = this.peek();
    if (t.type === "number") {
      this.advance();
      const n = Number(t.value);
      if (Number.isNaN(n)) throw new Error(`Invalid number '${t.value}'`);
      return n;
    }
    if (t.type === "lparen") {
      this.advance();
      const value = this.parseExpression();
      this.expect("rparen");
      return value;
    }
    if (t.type === "ident") {
      this.advance();
      const name = t.value.toLowerCase();
      if (name === "sqrt") {
        this.expect("lparen");
        const arg = this.parseExpression();
        this.expect("rparen");
        if (arg < 0) throw new Error("Cannot take sqrt of a negative number");
        return Math.sqrt(arg);
      }
      throw new Error(`Unknown function '${t.value}'`);
    }
    throw new Error(`Unexpected token '${t.value || t.type}'`);
  }
}

export function evaluateExpression(expression: string): number {
  const tokens = tokenizeExpression(expression);
  return new ExpressionParser(tokens).parse();
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

async function runLoopBody(
  history: Message[],
  onToken: (token: string) => void,
  onToolEvent: ((event: ToolEvent) => void) | undefined,
  tools: Tool[],
  client: ChatCompletionsClient,
  maxIterations: number
): Promise<string> {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const recent = history.slice(-HISTORY_LIMIT);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...recent.map((m) => ({ role: m.role, content: m.content })),
  ];

  let lastAssistantText = "";

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
      return text;
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
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content:
            "Error: response was truncated before this tool call completed. Please retry with a smaller request.",
        });
      }
      continue;
    }

    for (const tc of toolCalls) {
      onToolEvent?.({
        type: "tool_start",
        toolCallId: tc.id,
        toolName: tc.name,
        args: tryParseArgsForEvent(tc.arguments),
      });
      const result = await executeToolCall(tc, toolsByName);
      onToolEvent?.({
        type: "tool_end",
        toolCallId: tc.id,
        toolName: tc.name,
        isError: result.isError,
      });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result.content });
    }
  }

  console.warn(
    `[tool-loop] hit max iterations (${maxIterations}) without a final answer - ` +
      `returning ${lastAssistantText ? "the last partial answer" : "the fallback message"}`
  );
  return lastAssistantText || FALLBACK_MESSAGE;
}

export async function runToolLoop(
  history: Message[],
  onToken: (token: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
  options: ToolLoopOptions = {}
): Promise<string> {
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
