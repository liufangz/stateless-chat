import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool } from "../tool-loop.js";
import { REPO_ROOT } from "./bash.js";
import { resolveWritePath, type PathJailRoots } from "./file-path-jail.js";
import { writeFileAtomic } from "./atomic-write.js";

const MAX_WRITE_BYTES = 256 * 1024;

export interface WriteFileToolOptions {
  roots?: PathJailRoots;
}

export function createWriteFileTool(options?: WriteFileToolOptions): Tool {
  const roots = options?.roots ?? { repoRoot: REPO_ROOT };

  return {
    name: "write_file",
    description:
      "Write content to a file under the project root, creating parent directories as needed. " +
      "Overwrites the file if it already exists. Writes to .env, .git, or node_modules are rejected.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path under the project root. Relative paths resolve under the project root; absolute " +
            "paths must start with /repo/. Writes to .env, .git, or node_modules are rejected.",
        },
        content: { type: "string", description: "Full file content (overwrites if the file exists)" },
      },
      required: ["path", "content"],
    },
    async execute(args: unknown): Promise<string> {
      const { path: rawPath, content } = (args ?? {}) as { path?: unknown; content?: unknown };
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        throw new Error("write_file requires a non-empty 'path' string");
      }
      if (typeof content !== "string") {
        throw new Error("write_file requires a 'content' string");
      }
      const byteLength = Buffer.byteLength(content, "utf-8");
      if (byteLength > MAX_WRITE_BYTES) {
        throw new Error(`write_file content is ${byteLength} bytes, exceeding the ${MAX_WRITE_BYTES}-byte limit`);
      }

      const targetPath = await resolveWritePath(rawPath, roots);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await writeFileAtomic(targetPath, content);

      return `Successfully wrote ${byteLength} bytes to ${rawPath}`;
    },
  };
}

export const WRITE_FILE_TOOL: Tool = createWriteFileTool();
