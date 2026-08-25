import type { Tool } from "../tool-loop.js";

export const getCurrentDatetimeTool: Tool = {
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
