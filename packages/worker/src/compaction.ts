/**
 * pi-style token-budgeted auto-compaction.
 *
 * Ported from pi's coding-agent compaction model
 * (~/pi-source/packages/coding-agent/src/core/compaction/compaction.ts),
 * adapted from pi's AgentMessage/SessionEntry structures to this repo's
 * Postgres `messages` rows and OpenAI-wire `ChatMessage` shape. Pure
 * functions - no DB or LLM I/O except through the injected client in
 * `summarize`/`summarizeTurnPrefix`, so this is fully unit-testable with a
 * fake client (see test/compaction.test.ts).
 */

import type { Message } from "@stateless-chat/shared";

// ============================================================================
// Token estimation
// ============================================================================

// Conservative char-based estimator: ASCII costs ~4 chars/token (English
// prose), non-ASCII (CJK, emoji, etc.) costs ~1.5 chars/token since those
// scripts tokenize much denser. Overestimating is safe here - the only
// failure mode we're guarding against is context overflow, so erring toward
// "compact a little early" beats erring toward "blow the context window".
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 128) {
      asciiChars++;
    } else {
      nonAsciiChars++;
    }
  }
  return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5);
}

// Fixed overhead per message for role/field wire framing, mirroring pi's
// philosophy of padding the character-based estimate rather than trying to
// model the wire format exactly.
const PER_MESSAGE_OVERHEAD_TOKENS = 4;
// Applied once to the total, not per-message - accounts for JSON escaping,
// field names repeated per message, etc. that the char-count heuristic
// doesn't otherwise capture.
const WIRE_SAFETY_FACTOR = 1.1;

// Structural subset of tool-loop.ts's `ChatMessage` - kept independent (no
// import) so this module has no dependency on tool-loop.ts and both can
// import from each other's exports without a cycle.
export interface CompactableToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface CompactableMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: CompactableToolCall[];
  tool_call_id?: string;
}

function estimateMessageTokens(message: CompactableMessage): number {
  let tokens = PER_MESSAGE_OVERHEAD_TOKENS;
  if (message.content) tokens += estimateTokens(message.content);
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      tokens += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments);
    }
  }
  return tokens;
}

export function estimateMessagesTokens(messages: CompactableMessage[]): number {
  const total = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  return Math.ceil(total * WIRE_SAFETY_FACTOR);
}

/** Same estimate, applied to a raw DB row instead of a wire ChatMessage. */
function estimateRowTokens(row: Message): number {
  let tokens = PER_MESSAGE_OVERHEAD_TOKENS;
  if (row.content) tokens += estimateTokens(row.content);
  if (row.tool_calls) {
    for (const tc of row.tool_calls) {
      tokens += estimateTokens(tc.name) + estimateTokens(tc.arguments);
    }
  }
  return tokens;
}

export function shouldCompact(messages: CompactableMessage[], thresholdTokens: number): boolean {
  return estimateMessagesTokens(messages) > thresholdTokens;
}

// ============================================================================
// Pre-turn cut point (row-based, turn boundary = 'user' row)
// ============================================================================

export interface TurnCutPoint {
  /** Index into `rows` of the first row to keep (always a 'user' row). */
  index: number;
  /** id of the row at `index` - persisted as compactions.first_kept_message_id. */
  rowId: string;
}

/**
 * Find the cut point for a pre-turn compaction pass, walking backward from
 * the newest row and accumulating estimated tokens until `keepRecentTokens`
 * is reached. The cut always lands on a 'user' row (a turn boundary), and
 * only rows in [startIndex, rows.length) are considered - `startIndex` is
 * the previous compaction's kept boundary, or 0 for a conversation's first
 * compaction.
 *
 * The newest 'user' row (the turn that triggered this runToolLoop call) is
 * never cut into: the search only ever lands at or before it, because it is
 * itself the last candidate cut point.
 *
 * Returns null when there's nothing worth summarizing - either no 'user'
 * row exists in range, or the resulting span to summarize would be empty
 * (the whole span already fits under keepRecentTokens).
 */
export function findTurnCutPoint(
  rows: Message[],
  keepRecentTokens: number,
  startIndex = 0
): TurnCutPoint | null {
  if (startIndex >= rows.length) return null;

  const cutPoints: number[] = [];
  for (let i = startIndex; i < rows.length; i++) {
    if (rows[i].role === "user") cutPoints.push(i);
  }
  if (cutPoints.length === 0) return null;

  // Default when the whole span never crosses the budget: cut at the first
  // user row in range, i.e. keep everything (which then collapses to a
  // no-op below since there's nothing before it to summarize).
  let cutIndex = cutPoints[0];

  let accumulated = 0;
  for (let i = rows.length - 1; i >= startIndex; i--) {
    accumulated += estimateRowTokens(rows[i]);
    if (accumulated >= keepRecentTokens) {
      for (let c = cutPoints.length - 1; c >= 0; c--) {
        if (cutPoints[c] <= i) {
          cutIndex = cutPoints[c];
          break;
        }
      }
      break;
    }
  }

  if (cutIndex <= startIndex) return null;

  return { index: cutIndex, rowId: rows[cutIndex].id };
}

// ============================================================================
// Mid-loop cut point (ChatMessage-based, turn boundary = 'assistant' row)
// ============================================================================

export interface AssistantCutPoint {
  /** Index into `messages` of the first message to keep (an 'assistant' row). */
  index: number;
}

/**
 * Find the split-turn cut point for a mid-loop compaction pass: walk
 * backward from the end of `messages` accumulating estimated tokens until
 * `keepRecentTokens` is reached, landing on an 'assistant' row (never a
 * 'tool' row - a tool result must stay glued to its tool call). Only
 * messages in (turnStartIndex, messages.length) are eligible cut points, so
 * the cut always stays inside the currently-open turn and the turn's own
 * user message is never orphaned from its summary.
 *
 * Returns null when no valid cut exists in range (e.g. the turn has only
 * produced one assistant message so far - splitting would keep nothing).
 */
export function findAssistantCutPoint(
  messages: CompactableMessage[],
  turnStartIndex: number,
  keepRecentTokens: number
): AssistantCutPoint | null {
  const cutPoints: number[] = [];
  for (let i = turnStartIndex + 1; i < messages.length; i++) {
    if (messages[i].role === "assistant") cutPoints.push(i);
  }
  if (cutPoints.length === 0) return null;

  let cutIndex: number | null = null;
  let accumulated = 0;
  for (let i = messages.length - 1; i > turnStartIndex; i--) {
    accumulated += estimateMessageTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      for (let c = cutPoints.length - 1; c >= 0; c--) {
        if (cutPoints[c] <= i) {
          cutIndex = cutPoints[c];
          break;
        }
      }
      break;
    }
  }

  // Budget never crossed within this turn - nothing worth splitting yet.
  if (cutIndex === null) return null;
  // Cutting at the very first assistant row of the turn would leave an
  // empty prefix to summarize - not a useful split.
  if (cutIndex <= turnStartIndex + 1) return null;

  return { index: cutIndex };
}

/** Index of the last 'user'-role message in `messages`, or -1 if none. */
export function findLastUserIndex(messages: CompactableMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

// ============================================================================
// Splicing
// ============================================================================

/**
 * Replace messages[keepPrefixCount..cutIndex) with a single summary message.
 * `keepPrefixCount` leading messages (system prompt, and - for a mid-loop
 * split that lands after an existing pre-turn summary - that summary
 * message too) are preserved verbatim ahead of the new summary.
 */
export function applyCompaction<T>(
  messages: T[],
  cutIndex: number,
  summaryMessage: T,
  keepPrefixCount = 1
): T[] {
  return [...messages.slice(0, keepPrefixCount), summaryMessage, ...messages.slice(cutIndex)];
}

// ============================================================================
// Serialization (rows/messages -> plain text for the summarization prompt)
// ============================================================================

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function serializeRow(row: Message): string {
  if (row.role === "user") {
    return row.content ? `[User]: ${row.content}` : "";
  }
  if (row.role === "assistant") {
    if (row.tool_calls && row.tool_calls.length > 0) {
      const calls = row.tool_calls.map((tc) => `${tc.name}(${tc.arguments})`).join("; ");
      return `[Assistant tool calls]: ${calls}`;
    }
    return row.content ? `[Assistant]: ${row.content}` : "";
  }
  if (row.role === "tool") {
    return row.content ? `[Tool result]: ${truncateForSummary(row.content, TOOL_RESULT_MAX_CHARS)}` : "";
  }
  return "";
}

export function serializeRows(rows: Message[]): string {
  return rows.map(serializeRow).filter((line) => line.length > 0).join("\n\n");
}

function serializeChatMessage(message: CompactableMessage): string {
  if (message.role === "user") {
    return message.content ? `[User]: ${message.content}` : "";
  }
  if (message.role === "assistant") {
    if (message.tool_calls && message.tool_calls.length > 0) {
      const calls = message.tool_calls
        .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
        .join("; ");
      return `[Assistant tool calls]: ${calls}`;
    }
    return message.content ? `[Assistant]: ${message.content}` : "";
  }
  if (message.role === "tool") {
    return message.content
      ? `[Tool result]: ${truncateForSummary(message.content, TOOL_RESULT_MAX_CHARS)}`
      : "";
  }
  return "";
}

export function serializeChatMessages(messages: CompactableMessage[]): string {
  return messages.map(serializeChatMessage).filter((line) => line.length > 0).join("\n\n");
}

// ============================================================================
// Summarization prompts
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Your task is to read a conversation between a " +
  "user and an AI assistant, then produce a structured summary following the exact format " +
  "specified.\n\n" +
  "Do NOT continue the conversation. Do NOT respond to any questions in the conversation. " +
  "ONLY output the structured summary.";

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the conversation.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the conversation covers different topics.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by the user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/questions answered]

### In Progress
- [ ] [Current, unresolved work]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Files Touched
- [Files read or modified via tools, one line each, noting "read" or "modified"]
- [Or "(none)" if no file tools were used]

## Critical Context
- [Any data, examples, numbers, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, numbers, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- PRESERVE exact file paths, function names, numbers, and error messages
- If something is no longer relevant, you may remove it

Use the EXACT same format as the previous summary (Goal / Constraints & Preferences / Progress / Key Decisions / Files Touched / Critical Context).`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep in full. The SUFFIX (most recent tool calls and progress) is retained separately and will follow this summary in context.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions, tool results, and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export function buildSummarizePrompt(rowsToSummarize: Message[], previousSummary: string | null): string {
  const conversationText = serializeRows(rowsToSummarize);
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
    prompt += UPDATE_SUMMARIZATION_PROMPT;
  } else {
    prompt += SUMMARIZATION_PROMPT;
  }
  return prompt;
}

function buildTurnPrefixPrompt(messages: CompactableMessage[]): string {
  const conversationText = serializeChatMessages(messages);
  return `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
}

// ============================================================================
// Summarization (non-streaming LLM call, no tools)
// ============================================================================

export interface SummarizationUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface SummarizationResult {
  summary: string;
  usage: SummarizationUsage;
}

// Minimal structural subset of the OpenAI SDK needed for a non-streaming
// completion - mirrors tool-loop.ts's ChatCompletionsClient pattern so a
// test fake only needs to implement this, not the full SDK surface.
export interface SummarizationClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        max_tokens: number;
        temperature: number;
      }): Promise<{
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
}

const SUMMARIZATION_MAX_TOKENS = 600;
const SUMMARIZATION_TEMPERATURE = 0.2;

async function runSummarization(
  client: SummarizationClient,
  model: string,
  promptText: string
): Promise<SummarizationResult> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
      { role: "user", content: promptText },
    ],
    max_tokens: SUMMARIZATION_MAX_TOKENS,
    temperature: SUMMARIZATION_TEMPERATURE,
  });
  const summary = response.choices?.[0]?.message?.content ?? "";
  return {
    summary,
    usage: {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

/** Pre-turn (or manual) summarization of a span of persisted DB rows. */
export function summarize(
  client: SummarizationClient,
  rows: Message[],
  previousSummary: string | null,
  model: string
): Promise<SummarizationResult> {
  return runSummarization(client, model, buildSummarizePrompt(rows, previousSummary));
}

/**
 * Mid-loop split-turn summarization of the prefix of an in-progress turn.
 * Operates on wire ChatMessages (not DB rows) since a split turn's prefix
 * only exists in the in-memory `messages` array being built during the tool
 * loop - it hasn't necessarily been persisted yet.
 */
export function summarizeTurnPrefix(
  client: SummarizationClient,
  messages: CompactableMessage[],
  model: string
): Promise<SummarizationResult> {
  return runSummarization(client, model, buildTurnPrefixPrompt(messages));
}
