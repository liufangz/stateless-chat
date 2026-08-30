import type { ToolExchangeRecord } from "@stateless-chat/shared";

// ---------------------------------------------------------------------------
// pi-style lifecycle events for a stateless-chat turn.
//
// Mirrors the event taxonomy of `@earendil-works/pi-agent-core`:
//   - agent lifecycle   (one per processed user message / worker run)
//   - turn lifecycle    (one assistant response + its tool calls/results)
//   - message lifecycle (user, assistant, and tool-result messages)
//   - tool execution    (per tool call, incl. start/end)
//
// Events are emitted through a `Lifecycle` registry whose listeners are
// awaited in subscription order and are part of the turn's settlement (a
// failing listener fails the emit, same as pi's Agent.subscribe listeners).
// This is purely additive: no listeners means no behavior change, and the
// pre-existing `onToken` / `onToolEvent` callbacks keep working untouched.
// ---------------------------------------------------------------------------

export type LifecycleMessageRole = "user" | "assistant" | "tool";

export interface LifecycleMessage {
  role: LifecycleMessageRole;
  content: string | null;
  /** tool-result messages: the call id they answer. */
  toolCallId?: string;
  /** assistant messages: tool calls requested in the same iteration. */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export type AgentEvent =
  // Agent lifecycle - one per processed message on the worker.
  | { type: "agent_start" }
  | { type: "agent_end"; messages: LifecycleMessage[] }
  // Turn lifecycle - a turn is one assistant response + any tool calls/results.
  | { type: "turn_start" }
  | { type: "turn_end"; message: LifecycleMessage; toolResults: ToolExchangeRecord[] }
  // Message lifecycle - emitted for user, assistant, and tool-result messages.
  | { type: "message_start"; message: LifecycleMessage }
  // Only emitted for assistant messages while streaming.
  | { type: "message_update"; message: LifecycleMessage; contentDelta: string }
  | { type: "message_end"; message: LifecycleMessage }
  // Tool execution lifecycle.
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  // Reserved for tools that stream partial output; nothing emits it today.
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: string; isError: boolean };

export type LifecycleListener = (event: AgentEvent) => Promise<void> | void;

/**
 * Ordered event registry, modeled on pi's `Agent.subscribe`:
 * listeners are awaited in subscription order and are part of the current
 * run's settlement (a throwing listener propagates and aborts the turn).
 */
export class Lifecycle {
  private readonly listeners = new Set<LifecycleListener>();

  /** Subscribe; returns an unsubscribe function. */
  on(listener: LifecycleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit an event, awaiting each listener in subscription order. */
  async emit(event: AgentEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      await listener(event);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

// --- Decision hooks (pi's beforeToolCall / afterToolCall / ...) ------------

export interface BeforeToolCallContext {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface AfterToolCallContext {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: string;
  isError: boolean;
}

export interface ShouldStopAfterTurnContext {
  /** Durable, cross-restart iteration id (startIteration + local round). */
  iteration: number;
  /** Text streamed in the most recent iteration before its tool calls. */
  lastAssistantText: string;
  toolExchange: ToolExchangeRecord[];
}

export interface PrepareNextTurnContext {
  iteration: number;
  /** Next iteration's number (this is the turn about to run). */
  nextIteration: number;
  /** Messages about to be sent to the model (pre-injection, read-only). */
  messages: LifecycleMessage[];
}

export interface LifecycleHooks {
  /**
   * Fired before a tool call executes. Return `{ args }` to execute with
   * patched arguments, or `{ stop: true, reason }` to skip execution and
   * fail the call with `reason`. `undefined` = run as-is.
   */
  beforeToolCall?(
    context: BeforeToolCallContext
  ): Promise<{ args?: unknown; stop?: boolean; reason?: string } | undefined | void>;

  /**
   * Fired after a tool call executes. Return `{ result }` to replace the
   * result the model sees (and that gets persisted).
   */
  afterToolCall?(
    context: AfterToolCallContext
  ): Promise<{ result?: string } | undefined | void>;

  /**
   * Fired at the top of every iteration after the first. Return `true` to
   * stop the tool loop and go straight to the answer-now wrap-up (the
   * model is told to answer from what was gathered, no further tools).
   */
  shouldStopAfterTurn?(context: ShouldStopAfterTurnContext): boolean | Promise<boolean>;

  /**
   * Fired before every iteration after the first. Return additional
   * messages to inject into the model context for the upcoming iteration.
   */
  prepareNextTurn?(context: PrepareNextTurnContext): Promise<LifecycleMessage[] | undefined | void>;
}

/**
 * Purely observational hooks: log every hook firing, then pass everything
 * through unchanged (no veto, no patch, never stops the loop, injects
 * nothing). Gives the hook system a real caller instead of sitting unused,
 * without altering turn behavior - safe to wire into production as-is.
 */
/**
 * Example lifecycle listener: logs a signal whenever a user or assistant
 * message finishes (message_end), skipping tool-result messages entirely
 * (those carry a tool's raw output, not something worth signaling on here).
 * Pass to `lifecycle.on(...)` - purely observational, changes nothing.
 */
export function createMessageSignalLogger(log: (...args: unknown[]) => void): LifecycleListener {
  return (event) => {
    if (event.type !== "message_end" || event.message.role === "tool") return;
    const content = event.message.content ?? "";
    const preview = content.length > 80 ? `${content.slice(0, 80)}...` : content;
    log(`[signal] message: role=${event.message.role} chars=${content.length} "${preview}"`);
  };
}

export function createLoggingHooks(log: (...args: unknown[]) => void): LifecycleHooks {
  return {
    async beforeToolCall({ toolCallId, toolName, args }) {
      log(`[hooks] beforeToolCall: ${toolName} (${toolCallId})`, args);
      return undefined;
    },
    async afterToolCall({ toolCallId, toolName, result, isError }) {
      log(
        `[hooks] afterToolCall: ${toolName} (${toolCallId}) -> ${result.length} chars, isError=${isError}`
      );
      return undefined;
    },
    async shouldStopAfterTurn({ iteration, toolExchange }) {
      log(`[hooks] shouldStopAfterTurn: iteration=${iteration}, toolCallsSoFar=${toolExchange.length}`);
      return false;
    },
    async prepareNextTurn({ iteration, nextIteration }) {
      log(`[hooks] prepareNextTurn: iteration=${iteration} -> nextIteration=${nextIteration}`);
      return undefined;
    },
  };
}
