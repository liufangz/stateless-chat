import { describe, it, expect, vi } from "vitest";
import {
  buildBashDockerArgs,
  runBash,
  createBashTool,
  type SpawnResult,
} from "../src/tools/bash.js";
import { DEFAULT_TOOLS } from "../src/tool-loop.js";

describe("buildBashDockerArgs", () => {
  it("returns the exact sandboxed docker run argv", () => {
    const args = buildBashDockerArgs();
    expect(args).toEqual([
      "run",
      "-i",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "256m",
      "--pids-limit",
      "64",
      "--cpus",
      "0.5",
      "-u",
      "1000:1000",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=16m",
      "-e",
      "HOME=/work",
      "-v",
      "/home/ubuntu/stateless-chat:/repo:ro",
      "-v",
      "/home/ubuntu/.stateless-chat-workspace:/work:rw",
      "-w",
      "/work",
      "node:22-slim",
      "/bin/bash",
      "-s",
    ]);
  });

  it("contains every required sandbox flag", () => {
    const args = buildBashDockerArgs();
    for (const flag of [
      "--network",
      "none",
      "--rm",
      "--cap-drop",
      "ALL",
      "--read-only",
      "-u",
      "1000:1000",
      "-w",
      "/work",
      "/bin/bash",
      "-s",
    ]) {
      expect(args).toContain(flag);
    }
    expect(args.some((a) => a.endsWith(":ro"))).toBe(true);
    expect(args.some((a) => a.endsWith(":rw") || a.includes(":rw,"))).toBe(true);
  });
});

describe("runBash", () => {
  it("passes the script via stdin to the spawn function and maps stdout/code", async () => {
    const spawnFn = vi.fn(
      async (_args: string[], input: string): Promise<SpawnResult> => {
        expect(input).toBe("echo hello");
        return { stdout: "hello\n", code: 0 };
      }
    );

    const result = await runBash("echo hello", spawnFn);

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ stdout: "hello\n", code: 0 });
  });

  it("passes the exact docker args from buildBashDockerArgs to spawnFn", async () => {
    const spawnFn = vi.fn(async (): Promise<SpawnResult> => ({ stdout: "", code: 0 }));
    await runBash("true", spawnFn);
    expect(spawnFn).toHaveBeenCalledWith(buildBashDockerArgs(), "true");
  });

  it("truncates output over 4000 chars with a truncation suffix", async () => {
    const long = "x".repeat(5000);
    const spawnFn = vi.fn(async (): Promise<SpawnResult> => ({ stdout: long, code: 0 }));

    const result = await runBash("cmd", spawnFn);

    expect(result.stdout.length).toBeLessThan(long.length);
    expect(result.stdout.endsWith("\n...[output truncated]")).toBe(true);
    expect(result.stdout.startsWith("x".repeat(4000))).toBe(true);
  });

  it("does not truncate output at or under 4000 chars", async () => {
    const short = "y".repeat(4000);
    const spawnFn = vi.fn(async (): Promise<SpawnResult> => ({ stdout: short, code: 0 }));

    const result = await runBash("cmd", spawnFn);

    expect(result.stdout).toBe(short);
  });

  it("rejects when spawnFn throws (docker unavailable)", async () => {
    const spawnFn = vi.fn(async (): Promise<SpawnResult> => {
      throw new Error("spawn docker ENOENT");
    });

    await expect(runBash("cmd", spawnFn)).rejects.toThrow(/docker/i);
  });

  it("rejects after the injected timeout when spawnFn never resolves", async () => {
    const spawnFn = vi.fn(() => new Promise<SpawnResult>(() => {}));

    await expect(runBash("cmd", spawnFn, 50)).rejects.toThrow(/timed out/i);
  }, 5000);
});

describe("createBashTool execute()", () => {
  it("returns stdout on a successful (exit 0) command", async () => {
    const spawnFn = vi.fn(async (): Promise<SpawnResult> => ({ stdout: "ok\n", code: 0 }));
    const tool = createBashTool({ spawnFn });

    const result = await tool.execute({ command: "echo ok" });

    expect(result).toBe("ok\n");
  });

  it("throws on a non-zero exit code", async () => {
    const spawnFn = vi.fn(
      async (): Promise<SpawnResult> => ({ stdout: "boom", code: 1 })
    );
    const tool = createBashTool({ spawnFn });

    await expect(tool.execute({ command: "false" })).rejects.toThrow();
  });

  it("throws a clear error when docker itself is unavailable", async () => {
    const spawnFn = vi.fn(async (): Promise<SpawnResult> => {
      throw new Error("spawn docker ENOENT");
    });
    const tool = createBashTool({ spawnFn });

    await expect(tool.execute({ command: "echo hi" })).rejects.toThrow(/docker/i);
  });

  it("throws when the sandboxed command hangs past the per-tool timeout", async () => {
    const spawnFn = vi.fn(() => new Promise<SpawnResult>(() => {}));
    const tool = createBashTool({ spawnFn, timeoutMs: 50 });

    await expect(tool.execute({ command: "sleep 999" })).rejects.toThrow(/timed out/i);
  }, 5000);

  it("rejects a missing/empty command before ever spawning", async () => {
    const spawnFn = vi.fn(async (): Promise<SpawnResult> => ({ stdout: "", code: 0 }));
    const tool = createBashTool({ spawnFn });

    await expect(tool.execute({})).rejects.toThrow();
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe("DEFAULT_TOOLS", () => {
  it("always includes datetime and calculator; bash only when TOOL_BASH_ENABLED=true", () => {
    const names = DEFAULT_TOOLS.map((t) => t.name);
    expect(names).toContain("get_current_datetime");
    expect(names).toContain("calculator");
    if (process.env.TOOL_BASH_ENABLED === "true") {
      expect(names).toContain("bash");
    } else {
      expect(names).not.toContain("bash");
    }
  });
});
