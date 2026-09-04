import { promises as fs } from "node:fs";
import type pg from "pg";
import type { Tool } from "../tool-loop.js";
import { HOME_ROOT } from "./bash.js";
import { canonicalLockKey, resolveWritePath, type PathJailRoots } from "./file-path-jail.js";
import { writeFileAtomic } from "./atomic-write.js";
import { createPostgresFileLock, withFileLock, type FileLock } from "./file-lock.js";

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
  /** Cross-process lock implementation. Defaults to the shared Postgres lock table. */
  lock?: FileLock;
  /** Only used when `lock` is omitted - passed through to createPostgresFileLock. */
  pool?: pg.Pool;
  leaseDurationMs?: number;
  acquireTimeoutMs?: number;
}

export function createEditFileTool(options?: EditFileToolOptions): Tool {
  const roots = options?.roots ?? { root: HOME_ROOT };
  const lock = options?.lock ?? createPostgresFileLock(options?.pool);

  return {
    name: "edit_file",
    description:
      "Edit any file under /home/ubuntu by replacing exact text. 'old_string' must match the file's " +
      "content exactly once. Dotfiles, .env, .git, node_modules, and files in any project are included. " +
      "Coordinates with other in-flight write_file/edit_file calls (including " +
      "from other worker processes) via a shared lock: the file is re-read fresh once the lock is " +
      "held, so if its content changed since you last saw it, 'old_string' simply won't match anymore " +
      "and this fails clearly instead of applying against stale content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path under /home/ubuntu (same rules as write_file)" },
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
      const lockKey = await canonicalLockKey(targetPath);

      return withFileLock(
        lockKey,
        async (ctx) => {
          // The read happens INSIDE the lock, not before acquiring it - this
          // is what makes old_string's uniqueness check a real precondition
          // against the current file rather than a snapshot taken before
          // some other lock holder's edit landed. Held through the final
          // rename below, not just around it.
          let content: string;
          try {
            content = await fs.readFile(targetPath, "utf-8");
          } catch (err) {
            throw new Error(`Could not edit file: ${rawPath}. ${err instanceof Error ? err.message : String(err)}`);
          }

          const occurrences = countOccurrences(content, oldString);
          if (occurrences === 0) {
            throw new Error(
              `Could not find the exact text in ${rawPath}. old_string must match exactly, including ` +
                "whitespace and newlines - if this file was recently edited (by you or someone else), " +
                "re-read it and retry with the current content."
            );
          }
          if (occurrences > 1) {
            throw new Error(
              `Found ${occurrences} occurrences of old_string in ${rawPath}. old_string must be unique - add more context.`
            );
          }

          // Last check before the actual mutation: if the heartbeat has
          // already told us this lock was reclaimed by someone else, abort
          // here rather than writing anyway - withFileLock would refuse to
          // report this as a success regardless, but checking here avoids
          // writing at all in the common case where loss is detected before
          // this point (see FileLockContext's doc comment for why this
          // can't be a hard guarantee once the write itself has started).
          if (ctx.isLeaseLost()) {
            throw new Error(
              `Aborting edit of '${rawPath}': the file lock was reclaimed by another owner before the ` +
                "write happened - not applying this change. Re-read the file and retry."
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
        { lock, leaseDurationMs: options?.leaseDurationMs, acquireTimeoutMs: options?.acquireTimeoutMs }
      );
    },
  };
}

export const EDIT_FILE_TOOL: Tool = createEditFileTool();
