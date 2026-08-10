import OpenAI from "openai";
import { env } from "@stateless-chat/shared";
import type { Message } from "@stateless-chat/shared";

const client = new OpenAI({
  apiKey: env.openaiApiKey,
  baseURL: env.openaiBaseUrl,
});

const SYSTEM_PROMPT =
  "You are a helpful, concise assistant in a chat application. Keep replies short.";

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
