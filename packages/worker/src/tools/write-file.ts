import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { TOOL_MANIFESTS, manifestToJsonSchema } from "@stateless-chat/shared";
import type { Tool } from "../tool-loop.js";
import { HOME_ROOT } from "./bash.js";
import { canonicalLockKey, resolveWritePath, type PathJailRoots } from "./file-path-jail.js";
import { writeFileAtomic } from "./atomic-write.js";
import { createPostgresFileLock, withFileLock, type FileLock } from "./file-lock.js";

const WRITE_FILE_MANIFEST = TOOL_MANIFESTS.find((m) => m.name === "write_file")!;

const MAX_WRITE_BYTES = 256 * 1024;

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export interface WriteFileToolOptions {
  roots?: PathJailRoots;
  /** Cross-process lock implementation. Defaults to the shared Postgres lock table. */
  lock?: FileLock;
  /** Only used when `lock` is omitted - passed through to createPostgresFileLock. */
  pool?: pg.Pool;
  leaseDurationMs?: number;
  acquireTimeoutMs?: number;
}

export function createWriteFileTool(options?: WriteFileToolOptions): Tool {
  const roots = options?.roots ?? { root: HOME_ROOT };
  const lock = options?.lock ?? createPostgresFileLock(options?.pool);

  return {
    name: WRITE_FILE_MANIFEST.name,
    description: WRITE_FILE_MANIFEST.description,
    parameters: manifestToJsonSchema(WRITE_FILE_MANIFEST),
    async execute(args: unknown): Promise<string> {
      const {
        path: rawPath,
        content,
        expected_hash: expectedHash,
      } = (args ?? {}) as { path?: unknown; content?: unknown; expected_hash?: unknown };
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        throw new Error("write_file requires a non-empty 'path' string");
      }
      if (typeof content !== "string") {
        throw new Error("write_file requires a 'content' string");
      }
      if (expectedHash !== undefined && typeof expectedHash !== "string") {
        throw new Error("write_file 'expected_hash' must be a string");
      }
      const byteLength = Buffer.byteLength(content, "utf-8");
      if (byteLength > MAX_WRITE_BYTES) {
        throw new Error(`write_file content is ${byteLength} bytes, exceeding the ${MAX_WRITE_BYTES}-byte limit`);
      }

      const targetPath = await resolveWritePath(rawPath, roots);
      const lockKey = await canonicalLockKey(targetPath);

      return withFileLock(
        lockKey,
        async (ctx) => {
          // Hold the lock across the existence check, the precondition
          // validation, and the write/rename itself - not just the final
          // rename - so a concurrent writer can't slip a change in between
          // "we checked the hash" and "we wrote". Preserves the sensible
          // "just create it" path for a target that doesn't exist yet
          // regardless of whether expected_hash was passed.
          let existingContent: string | undefined;
          try {
            existingContent = await fs.readFile(targetPath, "utf-8");
          } catch {
            existingContent = undefined;
          }

          if (existingContent !== undefined && typeof expectedHash === "string") {
            const actualHash = sha256Hex(existingContent);
            if (actualHash !== expectedHash) {
              throw new Error(
                `write_file refused: '${rawPath}' has changed since expected_hash was computed ` +
                  `(expected ${expectedHash}, actual ${actualHash}). Re-read the file and retry with ` +
                  "the current content/hash, or omit expected_hash to overwrite unconditionally."
              );
            }
          }

          // Last check before the actual mutation - see edit-file.ts's
          // identical check for why this can only be a best-effort,
          // check-before-write guard, not a hard guarantee.
          if (ctx.isLeaseLost()) {
            throw new Error(
              `Aborting write to '${rawPath}': the file lock was reclaimed by another owner before the ` +
                "write happened - not writing. Retry if this write is still needed."
            );
          }

          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await writeFileAtomic(targetPath, content);

          return `Successfully wrote ${byteLength} bytes to ${rawPath}`;
        },
        { lock, leaseDurationMs: options?.leaseDurationMs, acquireTimeoutMs: options?.acquireTimeoutMs }
      );
    },
  };
}

export const WRITE_FILE_TOOL: Tool = createWriteFileTool();
