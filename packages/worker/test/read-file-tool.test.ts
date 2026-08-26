import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReadFileTool } from "../src/tools/read-file.js";
import type { PathJailRoots } from "../src/tools/file-path-jail.js";

let repoRoot: string;
let roots: PathJailRoots;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-repo-"));
  roots = { repoRoot };
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe("read_file tool", () => {
  it("resolves a bare relative path under the project root", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello");
    const tool = createReadFileTool({ roots });
    expect(await tool.execute({ path: "note.txt" })).toBe('<file path="note.txt" lines="1-1">\nhello\n</file>');
  });

  it("resolves /repo/... to the project root", async () => {
    await fs.writeFile(path.join(repoRoot, "README.md"), "docs");
    const tool = createReadFileTool({ roots });
    expect(await tool.execute({ path: "/repo/README.md" })).toBe(
      '<file path="/repo/README.md" lines="1-1">\ndocs\n</file>'
    );
  });

  it("wraps file content in an untrusted-content delimiter, keeping the continuation hint outside it", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    await fs.writeFile(path.join(repoRoot, "big.txt"), lines);
    const tool = createReadFileTool({ roots });
    const result = await tool.execute({ path: "big.txt", limit: 2 });
    const [filePart, hintPart] = result.split("\n\n");
    expect(filePart).toBe('<file path="big.txt" lines="1-2">\nline 1\nline 2\n</file>');
    expect(hintPart).toMatch(/^\[8 more lines in file\. Use offset=3 to continue\.\]$/);
  });

  it("rejects absolute paths outside the root", async () => {
    const tool = createReadFileTool({ roots });
    await expect(tool.execute({ path: "/etc/passwd" })).rejects.toThrow(/must start with \/repo\//);
  });

  it("rejects /work/... as an absolute path outside the root", async () => {
    const tool = createReadFileTool({ roots });
    await expect(tool.execute({ path: "/work/note.txt" })).rejects.toThrow(/must start with \/repo\//);
  });

  it("rejects .env paths even nominally under /repo", async () => {
    await fs.writeFile(path.join(repoRoot, ".env"), "SECRET=1");
    const tool = createReadFileTool({ roots });
    await expect(tool.execute({ path: "/repo/.env" })).rejects.toThrow(/not allowed/);
  });

  it("rejects .git/ paths under /repo", async () => {
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".git", "config"), "x");
    const tool = createReadFileTool({ roots });
    await expect(tool.execute({ path: "/repo/.git/config" })).rejects.toThrow(/not allowed/);
  });

  it("rejects node_modules paths under /repo", async () => {
    await fs.mkdir(path.join(repoRoot, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "node_modules", "pkg", "index.js"), "x");
    const tool = createReadFileTool({ roots });
    await expect(tool.execute({ path: "/repo/node_modules/pkg/index.js" })).rejects.toThrow(/not allowed/);
  });

  it("rejects '..' traversal", async () => {
    const tool = createReadFileTool({ roots });
    await expect(tool.execute({ path: "/repo/../etc/passwd" })).rejects.toThrow(/\.\./);
  });

  it("rejects a symlink that resolves outside the jailed root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(repoRoot, "link.txt"));
    const tool = createReadFileTool({ roots });
    await expect(tool.execute({ path: "/repo/link.txt" })).rejects.toThrow(/escapes the allowed root/);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("paginates via offset/limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    await fs.writeFile(path.join(repoRoot, "big.txt"), lines);
    const tool = createReadFileTool({ roots });
    const result = await tool.execute({ path: "big.txt", offset: 3, limit: 2 });
    expect(result).toContain("line 3");
    expect(result).toContain("line 4");
    expect(result).not.toContain("line 5");
    expect(result).toMatch(/Use offset=5 to continue/);
  });

  it("truncates output past the line cap with a continuation hint", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
    await fs.writeFile(path.join(repoRoot, "huge.txt"), lines);
    const tool = createReadFileTool({ roots });
    const result = await tool.execute({ path: "huge.txt" });
    expect(result).toContain("line 1");
    expect(result).not.toContain("line 300");
    expect(result).toMatch(/Showing lines 1-200 of 300/);
    expect(result).toMatch(/Use offset=201 to continue/);
  });

  it("throws a not-found error for a missing file", async () => {
    const tool = createReadFileTool({ roots });
    await expect(tool.execute({ path: "missing.txt" })).rejects.toThrow(/not found/i);
  });

  it("throws a directory-instead-of-file error", async () => {
    await fs.mkdir(path.join(repoRoot, "adir"));
    const tool = createReadFileTool({ roots });
    await expect(tool.execute({ path: "adir" })).rejects.toThrow();
  });

  it("rejects a missing path argument before any I/O", async () => {
    const tool = createReadFileTool({ roots });
    await expect(tool.execute({})).rejects.toThrow(/non-empty 'path'/);
  });

  it("rejects offset beyond end of file", async () => {
    await fs.writeFile(path.join(repoRoot, "small.txt"), "a\nb\nc");
    const tool = createReadFileTool({ roots });
    await expect(tool.execute({ path: "small.txt", offset: 100 })).rejects.toThrow(/beyond end of file/);
  });
});
