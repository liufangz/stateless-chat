import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEditFileTool } from "../src/tools/edit-file.js";
import type { PathJailRoots } from "../src/tools/file-path-jail.js";

let repoRoot: string;
let roots: PathJailRoots;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "edit-tool-repo-"));
  roots = { repoRoot };
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe("edit_file tool", () => {
  it("replaces a unique match and includes an old/new diff in the confirmation", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const tool = createEditFileTool({ roots });
    const result = await tool.execute({ path: "note.txt", old_string: "world", new_string: "there" });
    expect(result).toMatch(/Successfully replaced 1 occurrence/);
    expect(result).toContain("- world");
    expect(result).toContain("+ there");
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("hello there");
  });

  it("edits a file under an explicit /repo/ path", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const tool = createEditFileTool({ roots });
    await tool.execute({ path: "/repo/note.txt", old_string: "world", new_string: "there" });
    expect(await fs.readFile(path.join(repoRoot, "note.txt"), "utf-8")).toBe("hello there");
  });

  it("edits a file that is not itself writable, via rename instead of an in-place write", async () => {
    const targetPath = path.join(repoRoot, "note.txt");
    await fs.writeFile(targetPath, "hello world");
    await fs.chmod(targetPath, 0o444);
    const tool = createEditFileTool({ roots });
    await tool.execute({ path: "note.txt", old_string: "world", new_string: "there" });
    expect(await fs.readFile(targetPath, "utf-8")).toBe("hello there");
  });

  it("errors when old_string is not found", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const tool = createEditFileTool({ roots });
    await expect(tool.execute({ path: "note.txt", old_string: "missing", new_string: "x" })).rejects.toThrow(
      /Could not find the exact text/
    );
  });

  it("errors when old_string matches more than once", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "foo foo foo");
    const tool = createEditFileTool({ roots });
    await expect(tool.execute({ path: "note.txt", old_string: "foo", new_string: "bar" })).rejects.toThrow(
      /Found 3 occurrences/
    );
  });

  it("errors on a missing file", async () => {
    const tool = createEditFileTool({ roots });
    await expect(tool.execute({ path: "missing.txt", old_string: "a", new_string: "b" })).rejects.toThrow(
      /Could not edit file/
    );
  });

  it("rejects /work/... as a path outside the root before reading", async () => {
    const tool = createEditFileTool({ roots });
    await expect(
      tool.execute({ path: "/work/README.md", old_string: "world", new_string: "there" })
    ).rejects.toThrow(/Cannot write outside/);
  });

  it("rejects .env edits even under /repo", async () => {
    await fs.writeFile(path.join(repoRoot, ".env"), "SECRET=1");
    const tool = createEditFileTool({ roots });
    await expect(
      tool.execute({ path: "/repo/.env", old_string: "SECRET=1", new_string: "SECRET=2" })
    ).rejects.toThrow(/not allowed/);
    expect(await fs.readFile(path.join(repoRoot, ".env"), "utf-8")).toBe("SECRET=1");
  });

  it("rejects an empty old_string", async () => {
    await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world");
    const tool = createEditFileTool({ roots });
    await expect(tool.execute({ path: "note.txt", old_string: "", new_string: "x" })).rejects.toThrow(
      /non-empty 'old_string'/
    );
  });

  it("rejects '..' traversal", async () => {
    const tool = createEditFileTool({ roots });
    await expect(tool.execute({ path: "../escape.txt", old_string: "a", new_string: "b" })).rejects.toThrow(/\.\./);
  });
});
