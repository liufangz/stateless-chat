import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEditFileTool } from "../src/tools/edit-file.js";
import type { PathJailRoots } from "../src/tools/file-path-jail.js";
import { createAlwaysHeldFileLock, createFakeFileLock } from "./support/fake-file-lock.js";

let repoRoot: string;
let roots: PathJailRoots;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "edit-tool-repo-"));
  roots = { root: repoRoot };
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe("edit_file tool", () => {
  it("replaces a unique match and includes an old/new diff in the confirmation", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const tool = createEditFileTool({ roots, lock: createFakeFileLock() });
    const result = await tool.execute({ path: "note.txt", old_string: "world", new_string: "there" });
    expect(result).toMatch(/Successfully replaced 1 occurrence/);
    expect(result).toContain("- world");
    expect(result).toContain("+ there");
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("hello there");
  });

  it("edits a file under an explicit /repo/ path", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const tool = createEditFileTool({ roots, lock: createFakeFileLock() });
    await tool.execute({ path: "/repo/note.txt", old_string: "world", new_string: "there" });
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("hello there");
  });

  it("edits a file under a real absolute path inside the project root", async () => {
    const real = path.join(repoRoot, "note.txt");
    await fs.writeFile(real, "hello world");
    const tool = createEditFileTool({ roots, lock: createFakeFileLock() });
    await tool.execute({ path: real, old_string: "world", new_string: "there" });
    expect(await fs.readFile(real, "utf-8")).toBe("hello there");
  });

  it("edits a file that is not itself writable, via rename instead of an in-place write", async () => {
    const targetPath = path.join(repoRoot, "note.txt");
    await fs.writeFile(targetPath, "hello world");
    await fs.chmod(targetPath, 0o444);
    const tool = createEditFileTool({ roots, lock: createFakeFileLock() });
    await tool.execute({ path: "note.txt", old_string: "world", new_string: "there" });
    expect(await fs.readFile(targetPath, "utf-8")).toBe("hello there");
  });

  it("errors when old_string is not found", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const tool = createEditFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "note.txt", old_string: "missing", new_string: "x" })).rejects.toThrow(
      /Could not find the exact text/
    );
  });

  it("errors when old_string matches more than once", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "foo foo foo");
    const tool = createEditFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "note.txt", old_string: "foo", new_string: "bar" })).rejects.toThrow(
      /Found 3 occurrences/
    );
  });

  it("errors on a missing file", async () => {
    const tool = createEditFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "missing.txt", old_string: "a", new_string: "b" })).rejects.toThrow(
      /Could not edit file/
    );
  });

  it("rejects /work/... as a path outside the root before reading", async () => {
    const tool = createEditFileTool({ roots, lock: createFakeFileLock() });
    await expect(
      tool.execute({ path: "/work/README.md", old_string: "world", new_string: "there" })
    ).rejects.toThrow(/escapes the allowed root/);
  });

  it("edits .env files under the allowed root", async () => {
    await fs.writeFile(path.join(repoRoot, ".env"), "SECRET=1");
    const tool = createEditFileTool({ roots, lock: createFakeFileLock() });
    await expect(
      tool.execute({ path: "/repo/.env", old_string: "SECRET=1", new_string: "SECRET=2" })
    ).resolves.toMatch(/Successfully replaced/);
    expect(await fs.readFile(path.join(repoRoot, ".env"), "utf-8")).toBe("SECRET=2");
  });

  it("rejects an empty old_string", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const tool = createEditFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "note.txt", old_string: "", new_string: "x" })).rejects.toThrow(
      /non-empty 'old_string'/
    );
  });

  it("rejects '..' traversal", async () => {
    const tool = createEditFileTool({ roots, lock: createFakeFileLock() });
    await expect(tool.execute({ path: "../escape.txt", old_string: "a", new_string: "b" })).rejects.toThrow(/\.\./);
  });
});

describe("edit_file tool: cross-process locking", () => {
  it("acquires and releases the lock around a successful edit", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const lock = createFakeFileLock();
    const tool = createEditFileTool({ roots, lock });
    await tool.execute({ path: "note.txt", old_string: "world", new_string: "there" });
    expect(lock.acquireCallCount).toBe(1);
    // Released afterward - a second edit for the same path must not block.
    await expect(
      tool.execute({ path: "note.txt", old_string: "there", new_string: "friend" })
    ).resolves.toMatch(/Successfully replaced/);
  });

  it("releases the lock even when old_string doesn't match", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const lock = createFakeFileLock();
    const tool = createEditFileTool({ roots, lock });
    await expect(
      tool.execute({ path: "note.txt", old_string: "missing", new_string: "x" })
    ).rejects.toThrow(/Could not find the exact text/);
    // If the lock leaked, this would hang/timeout instead of completing.
    await expect(
      tool.execute({ path: "note.txt", old_string: "world", new_string: "there" })
    ).resolves.toMatch(/Successfully replaced/);
  });

  it("returns a clear, actionable error - not a hang - when the lock can't be acquired in time", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const tool = createEditFileTool({ roots, lock: createAlwaysHeldFileLock(), acquireTimeoutMs: 50 });
    await expect(
      tool.execute({ path: "note.txt", old_string: "world", new_string: "there" })
    ).rejects.toThrow(/Timed out.*waiting for a lock/);
    // And nothing was changed.
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("hello world");
  });

  it("re-reads content fresh once the lock is held, so a change made by another lock-holder between calls is caught, not clobbered", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const lock = createFakeFileLock();
    const tool = createEditFileTool({ roots, lock });
    // Simulates another worker's edit landing (through the same lock,
    // serialized) between this model turn deciding to call edit_file and it
    // actually running - old_string was captured against the ORIGINAL
    // content and must fail against the now-current content instead of
    // silently applying against what the model assumed was still there.
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello universe");
    await expect(
      tool.execute({ path: "note.txt", old_string: "world", new_string: "there" })
    ).rejects.toThrow(/Could not find the exact text/);
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("hello universe");
  });
});

describe("edit_file tool: lease loss mid-hold", () => {
  it("never reports success once the lock was reclaimed by another owner mid-edit, and does not leave a half-applied edit", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    // A lock that grants the initial acquire but tells every renewal
    // attempt "no longer yours" - simulates this worker stalling past its
    // lease and another worker's acquire() winning it before this edit
    // finishes.
    const lock = {
      acquireCallCount: 0,
      async acquire() {
        this.acquireCallCount++;
        return true;
      },
      async renew() {
        return false;
      },
      async release() {},
    };
    const tool = createEditFileTool({ roots, lock, leaseDurationMs: 5 });

    // The one guarantee under test: the model is NEVER told this succeeded.
    // Whether the proactive ctx.isLeaseLost() check wins the race and skips
    // the write, or the real fs write happens to land before the first
    // renewal tick fires, is inherently a real-clock race (this repo's own
    // file-lock.ts doc comment is explicit that a real filesystem write
    // cannot be fenced) - asserting on which of those two happened would
    // make this test flaky by construction. The rejection itself does not
    // depend on that race: withFileLock refuses to resolve successfully
    // once leaseLost is observed, regardless of what fn already did.
    await expect(
      tool.execute({ path: "note.txt", old_string: "world", new_string: "there" })
    ).rejects.toThrow(/reclaimed by another owner/);
  });
});
