import { TOOL_MANIFESTS, manifestToJsonSchema } from "@stateless-chat/shared";
import type { Tool } from "../tool-loop.js";

const MANIFEST = TOOL_MANIFESTS.find((m) => m.name === "get_current_datetime")!;

export const getCurrentDatetimeTool: Tool = {
  name: MANIFEST.name,
  description: MANIFEST.description,
  readOnly: MANIFEST.readOnly,
  parameters: manifestToJsonSchema(MANIFEST),
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
