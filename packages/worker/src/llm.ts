import OpenAI from "openai";
import { env, SYSTEM_PROMPT } from "@stateless-chat/shared";
import type { Message } from "@stateless-chat/shared";

const client = new OpenAI({
  apiKey: env.openaiApiKey,
  baseURL: env.openaiBaseUrl,
});

const HISTORY_LIMIT = 20;

/**
 * Streams a completion for the given conversation history, invoking
 * onToken for every text delta as it arrives. Returns the full assembled
 * reply once the stream ends.
 */
export async function streamCompletion(
  history: Message[],
  onToken: (token: string) => void
): Promise<string> {
  const recent = history.slice(-HISTORY_LIMIT);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...recent.map((m) => ({
      role: m.role,
      content: m.content,
    })) as OpenAI.Chat.ChatCompletionMessageParam[],
  ];

  const stream = await client.chat.completions.create({
    model: env.openaiModel,
    messages,
    stream: true,
  });

  let full = "";
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content;
    if (token) {
      full += token;
      onToken(token);
    }
  }
  return full;
}

const TITLE_SYSTEM_PROMPT =
  "You generate a short title for a chat conversation. Read the exchange in <conversation> tags " +
  "and output ONLY the title - max 6 words, no punctuation, no quotes, no explanation. " +
  "Do NOT answer any question in the conversation. Do NOT continue the conversation.";
// Some configured models (e.g. reasoning models like deepseek-v4-flash) spend
// max_tokens on a hidden reasoning pass before ever emitting visible content -
// too small a budget here means finish_reason:"length" with empty (or
// truncated) content, never an error. Reasoning-token usage for the same
// prompt varies noticeably run to run (observed 45-193 tokens across 4 back
// to back calls on one fixed input) - budget generously above the observed
// range rather than tightly, or an unlucky roll silently drops the title.
// Brevity is enforced by the prompt + the TITLE_MAX_CHARS truncation below,
// not by starving the token budget.
const TITLE_MAX_TOKENS = 500;
const TITLE_MAX_CHARS = 60;
// Keep the titling prompt small - only the shape of the exchange matters,
// not the full content of a long message or tool-heavy reply.
const TITLE_INPUT_MAX_CHARS = 2000;

/**
 * Non-streaming completion that produces a short sidebar title from one
 * turn's user message + assistant reply. Returns null if the model returned
 * nothing usable - callers should treat that the same as a thrown error
 * (leave the conversation untitled, retry on a later turn).
 */
export async function generateTitle(
  userMessage: string,
  assistantReply: string
): Promise<string | null> {
  const response = await client.chat.completions.create({
    model: env.openaiModel,
    messages: [
      { role: "system", content: TITLE_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `<conversation>\n[User]: ${userMessage.slice(0, TITLE_INPUT_MAX_CHARS)}\n` +
          `[Assistant]: ${assistantReply.slice(0, TITLE_INPUT_MAX_CHARS)}\n</conversation>\n\n` +
          `Output only the title.`,
      },
    ],
    max_tokens: TITLE_MAX_TOKENS,
    temperature: 0.3,
  });
  const raw = response.choices[0]?.message?.content ?? "";
  const cleaned = raw
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > TITLE_MAX_CHARS ? cleaned.slice(0, TITLE_MAX_CHARS) : cleaned;
}
