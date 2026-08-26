import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWriteFileTool } from "../src/tools/write-file.js";
import type { PathJailRoots } from "../src/tools/file-path-jail.js";

let repoRoot: string;
let roots: PathJailRoots;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "write-tool-repo-"));
  roots = { repoRoot };
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe("write_file tool", () => {
  it("writes a new file under a bare relative path", async () => {
    const tool = createWriteFileTool({ roots });
    const result = await tool.execute({ path: "note.txt", content: "hello" });
    expect(result).toMatch(/Successfully wrote 5 bytes/);
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("hello");
  });

  it("writes under an explicit /repo/ path", async () => {
    const tool = createWriteFileTool({ roots });
    await tool.execute({ path: "/repo/sub/note.txt", content: "hi" });
    expect(await fs.readFile(path.join(repoRoot, "sub", "note.txt"), "utf-8")).toBe("hi");
  });

  it("creates parent directories automatically", async () => {
    const tool = createWriteFileTool({ roots });
    await tool.execute({ path: "a/b/c/note.txt", content: "deep" });
    expect(await fs.readFile(path.join(repoRoot, "a", "b", "c", "note.txt"), "utf-8")).toBe("deep");
  });

  it("overwrites an existing file", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "old");
    const tool = createWriteFileTool({ roots });
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
    const tool = createWriteFileTool({ roots });
    await tool.execute({ path: "note.txt", content: "new" });
    expect(await fs.readFile(targetPath, "utf-8")).toBe("new");
  });

  it("does not leave a temp file behind after a successful write", async () => {
    const tool = createWriteFileTool({ roots });
    await tool.execute({ path: "note.txt", content: "hello" });
    const entries = await fs.readdir(repoRoot);
    expect(entries).toEqual(["note.txt"]);
  });

  it("rejects /work/... as outside the root, before writing", async () => {
    const tool = createWriteFileTool({ roots });
    await expect(tool.execute({ path: "/work/note.txt", content: "x" })).rejects.toThrow(/Cannot write outside/);
  });

  it("rejects '..' traversal", async () => {
    const tool = createWriteFileTool({ roots });
    await expect(tool.execute({ path: "../escape.txt", content: "x" })).rejects.toThrow(/\.\./);
  });

  it("rejects oversized content before writing", async () => {
    const tool = createWriteFileTool({ roots });
    const big = "x".repeat(256 * 1024 + 1);
    await expect(tool.execute({ path: "big.txt", content: big })).rejects.toThrow(/exceeding the 262144-byte limit/);
    await expect(fs.readFile(path.join(repoRoot, "big.txt"), "utf-8")).rejects.toThrow();
  });

  it("rejects .env writes even under /repo", async () => {
    const tool = createWriteFileTool({ roots });
    await expect(tool.execute({ path: "/repo/.env", content: "SECRET=1" })).rejects.toThrow(/not allowed/);
    await expect(fs.readFile(path.join(repoRoot, ".env"), "utf-8")).rejects.toThrow();
  });

  it("rejects a symlinked directory that resolves outside the root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "write-tool-outside-"));
    await fs.symlink(outside, path.join(repoRoot, "linkdir"));
    const tool = createWriteFileTool({ roots });
    await expect(tool.execute({ path: "linkdir/note.txt", content: "x" })).rejects.toThrow(
      /escapes the allowed root/
    );
    await expect(fs.readFile(path.join(outside, "note.txt"), "utf-8")).rejects.toThrow();
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("rejects a missing path argument before any I/O", async () => {
    const tool = createWriteFileTool({ roots });
    await expect(tool.execute({ content: "x" })).rejects.toThrow(/non-empty 'path'/);
  });

  it("rejects a missing content argument before any I/O", async () => {
    const tool = createWriteFileTool({ roots });
    await expect(tool.execute({ path: "note.txt" })).rejects.toThrow(/'content' string/);
  });
});
