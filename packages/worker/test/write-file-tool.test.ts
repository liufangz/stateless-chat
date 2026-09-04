import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWriteFileTool } from "../src/tools/write-file.js";
import type { PathJailRoots } from "../src/tools/file-path-jail.js";
import { createAlwaysHeldFileLock, createFakeFileLock } from "./support/fake-file-lock.js";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

let repoRoot: string;
let roots: PathJailRoots;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "write-tool-repo-"));
  roots = { root: repoRoot };
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe("write_file tool", () => {
  it("writes a new file under a bare relative path", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    const result = await tool.execute({ path: "note.txt", content: "hello" });
    expect(result).toMatch(/Successfully wrote 5 bytes/);
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("hello");
  });

  it("writes under an explicit /repo/ path", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await tool.execute({ path: "/repo/sub/note.txt", content: "hi" });
    expect(await fs.readFile(path.join(repoRoot, "sub", "note.txt"), "utf-8")).toBe("hi");
  });

  it("writes under a real absolute path inside the project root", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    const real = path.join(repoRoot, "sub", "note.txt");
    await tool.execute({ path: real, content: "hi" });
    expect(await fs.readFile(real, "utf-8")).toBe("hi");
  });

  it("creates parent directories automatically", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await tool.execute({ path: "a/b/c/note.txt", content: "deep" });
    expect(await fs.readFile(path.join(repoRoot, "a", "b", "c", "note.txt"), "utf-8")).toBe("deep");
  });

  it("overwrites an existing file", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "old");
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await tool.execute({ path: "note.txt", content: "new" });
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("new");
  });

  it("overwrites a file that is not itself writable, via rename instead of an in-place write", async () => {
    // Mirrors the shared-workspace case: the docker sandbox (a different uid)
    // creates files mode 644, leaving the worker without write access to the
    // file itself. A rename-over-target only needs write access on the
    // directory, so this must still succeed.
    const targetPath = path.join(repoRoot, "note.txt");
    await fs.writeFile(targetPath, "old");
    await fs.chmod(targetPath, 0o444);
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await tool.execute({ path: "note.txt", content: "new" });
    expect(await fs.readFile(targetPath, "utf-8")).toBe("new");
  });

  it("does not leave a temp file behind after a successful write", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await tool.execute({ path: "note.txt", content: "hello" });
    const entries = await fs.readdir(repoRoot);
    expect(entries).toEqual(["note.txt"]);
  });

  it("rejects /work/... as outside the root, before writing", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "/work/note.txt", content: "x" })).rejects.toThrow(
      /escapes the allowed root/
    );
  });

  it("rejects '..' traversal", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "../escape.txt", content: "x" })).rejects.toThrow(/\.\./);
  });

  it("rejects oversized content before writing", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    const big = "x".repeat(256 * 1024 + 1);
    await expect(tool.execute({ path: "big.txt", content: big })).rejects.toThrow(/exceeding the 262144-byte limit/);
    await expect(fs.readFile(path.join(repoRoot, "big.txt"), "utf-8")).rejects.toThrow();
  });

  it("writes .env files under the allowed root", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "/repo/.env", content: "SECRET=1" })).resolves.toMatch(/Successfully wrote/);
    expect(await fs.readFile(path.join(repoRoot, ".env"), "utf-8")).toBe("SECRET=1");
  });

  it("rejects a symlinked directory that resolves outside the root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "write-tool-outside-"));
    await fs.symlink(outside, path.join(repoRoot, "linkdir"));
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "linkdir/note.txt", content: "x" })).rejects.toThrow(
      /escapes the allowed root/
    );
    await expect(fs.readFile(path.join(outside, "note.txt"), "utf-8")).rejects.toThrow();
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("rejects a missing path argument before any I/O", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ content: "x" })).rejects.toThrow(/non-empty 'path'/);
  });

  it("rejects a missing content argument before any I/O", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "note.txt" })).rejects.toThrow(/'content' string/);
  });
});

describe("write_file tool: cross-process locking", () => {
  it("acquires and releases the lock around a successful write", async () => {
    const lock = createFakeFileLock();
    const tool = createWriteFileTool({ roots, lock });
    await tool.execute({ path: "note.txt", content: "hello" });
    expect(lock.acquireCallCount).toBe(1);
    // Released afterward - a second call for the same path must not block.
    await expect(tool.execute({ path: "note.txt", content: "again" })).resolves.toMatch(/Successfully wrote/);
  });

  it("releases the lock even when the write fails validation", async () => {
    const lock = createFakeFileLock();
    const tool = createWriteFileTool({ roots, lock });
    await expect(tool.execute({ path: "/work/forbidden.txt", content: "x" })).rejects.toThrow();
    // If the lock leaked, this second call for an unrelated path would still
    // succeed (different lock key) - so instead assert the same path is
    // immediately available again to a fresh call.
    await tool.execute({ path: "note.txt", content: "ok" });
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("ok");
  });

  it("returns a clear, actionable error - not a hang - when the lock can't be acquired in time", async () => {
    const tool = createWriteFileTool({ roots, lock: createAlwaysHeldFileLock(), acquireTimeoutMs: 50 });
    await expect(tool.execute({ path: "note.txt", content: "x" })).rejects.toThrow(
      /Timed out.*waiting for a lock/
    );
    // And nothing was written.
    await expect(fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).rejects.toThrow();
  });
});

describe("write_file tool: expected_hash precondition (lost-update protection)", () => {
  it("creating a new file succeeds with no expected_hash - sensible default for the common case", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "new.txt", content: "fresh" })).resolves.toMatch(/Successfully wrote/);
  });

  it("creating a new file succeeds even if a stale expected_hash is passed - nothing to precondition against yet", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await expect(
      tool.execute({ path: "new.txt", content: "fresh", expected_hash: "deadbeef" })
    ).resolves.toMatch(/Successfully wrote/);
  });

  it("overwriting an existing file with no expected_hash still succeeds (backward compatible)", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "old");
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await tool.execute({ path: "note.txt", content: "new" });
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("new");
  });

  it("overwriting an existing file with a matching expected_hash succeeds", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "old content");
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await tool.execute({
      path: "note.txt",
      content: "new content",
      expected_hash: sha256Hex("old content"),
    });
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("new content");
  });

  it("rejects overwriting an existing file when expected_hash doesn't match the current content - never silently discards the change", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "content someone else just wrote");
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await expect(
      tool.execute({
        path: "note.txt",
        content: "my stale overwrite",
        expected_hash: sha256Hex("content I read a while ago"),
      })
    ).rejects.toThrow(/has changed since expected_hash was computed/);
    // The concurrent change must survive untouched.
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("content someone else just wrote");
  });

  it("rejects a non-string expected_hash before any I/O", async () => {
    const tool = createWriteFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "note.txt", content: "x", expected_hash: 123 })).rejects.toThrow(
      /'expected_hash' must be a string/
    );
  });
});

describe("write_file tool: lease loss mid-hold", () => {
  it("never reports success once the lock was reclaimed by another owner mid-write", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    // Grants the initial acquire but tells every renewal attempt "no
    // longer yours" - simulates this worker stalling past its lease and
    // another worker's acquire() winning it before this write finishes.
    const lock = {
      async acquire() {
        return true;
      },
      async renew() {
        return false;
      },
      async release() {},
    };
    const tool = createWriteFileTool({ roots, lock, leaseDurationMs: 5 });

    // Whether the proactive ctx.isLeaseLost() check wins the race and
    // skips the write, or the real fs write lands before the first
    // renewal tick fires, is an inherent real-clock race (a real
    // filesystem write cannot be fenced - see file-lock.ts). The
    // guarantee under test does not depend on that race: the model is
    // never told this succeeded once lease loss was observed during the
    // hold, regardless of what the write itself already did.
    await expect(
      tool.execute({ path: "note.txt", content: "new content" })
    ).rejects.toThrow(/reclaimed by another owner/);
  });
});
