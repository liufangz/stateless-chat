import { promises as fs } from "node:fs";
import type { Tool } from "../tool-loop.js";
import { REPO_ROOT } from "./bash.js";
import { resolveWritePath, type PathJailRoots } from "./file-path-jail.js";
import { writeFileAtomic } from "./atomic-write.js";

function countOccurrences(content: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count++;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

export interface EditFileToolOptions {
  roots?: PathJailRoots;
}

export function createEditFileTool(options?: EditFileToolOptions): Tool {
  const roots = options?.roots ?? { repoRoot: REPO_ROOT };

  return {
    name: "edit_file",
    description:
      "Edit a file under the project root by replacing exact text. 'old_string' must match the file's " +
      "content exactly once.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path under the project root (same rules as write_file)" },
        old_string: {
          type: "string",
          description: "Exact text to replace. Must match exactly once in the file.",
        },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(args: unknown): Promise<string> {
      const {
        path: rawPath,
        old_string: oldString,
        new_string: newString,
      } = (args ?? {}) as { path?: unknown; old_string?: unknown; new_string?: unknown };
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        throw new Error("edit_file requires a non-empty 'path' string");
      }
      if (typeof oldString !== "string" || oldString === "") {
        throw new Error("edit_file requires a non-empty 'old_string' string");
      }
      if (typeof newString !== "string") {
        throw new Error("edit_file requires a 'new_string' string");
      }

      const targetPath = await resolveWritePath(rawPath, roots);

      let content: string;
      try {
        content = await fs.readFile(targetPath, "utf-8");
      } catch (err) {
        throw new Error(`Could not edit file: ${rawPath}. ${err instanceof Error ? err.message : String(err)}`);
      }

      const occurrences = countOccurrences(content, oldString);
      if (occurrences === 0) {
        throw new Error(
          `Could not find the exact text in ${rawPath}. old_string must match exactly, including whitespace and newlines.`
        );
      }
      if (occurrences > 1) {
        throw new Error(
          `Found ${occurrences} occurrences of old_string in ${rawPath}. old_string must be unique - add more context.`
        );
      }

      const index = content.indexOf(oldString);
      const newContent = content.slice(0, index) + newString + content.slice(index + oldString.length);
      await writeFileAtomic(targetPath, newContent);

      const diff = [
        ...oldString.split("\n").map((line) => `- ${line}`),
        ...newString.split("\n").map((line) => `+ ${line}`),
      ].join("\n");
      return `Successfully replaced 1 occurrence in ${rawPath}:\n${diff}`;
    },
  };
}

export const EDIT_FILE_TOOL: Tool = createEditFileTool();
