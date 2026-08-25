import { spawn } from "node:child_process";
import type { Tool } from "../tool-loop.js";

const OUTPUT_LIMIT = 4000;
const TRUNCATION_SUFFIX = "\n...[output truncated]";
const DEFAULT_TIMEOUT_MS = 20_000;

const REPO_ROOT = "/home/ubuntu/stateless-chat";
const WORKSPACE_DIR = "/home/ubuntu/.stateless-chat-workspace";

export interface SpawnResult {
  stdout: string;
  code: number;
}

export type SpawnFn = (args: string[], input: string) => Promise<SpawnResult>;

/**
 * Pure — returns the exact docker run argv. Tests assert this array directly,
 * so the sandbox flags (no network, read-only repo, dropped caps, non-root,
 * resource limits) are locked down independent of the execution path.
 */
export function buildBashDockerArgs(): string[] {
  return [
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
    `${REPO_ROOT}:/repo:ro`,
    "-v",
    `${WORKSPACE_DIR}:/work:rw`,
    "-w",
    "/work",
    "node:22-slim",
    "/bin/bash",
    "-s",
  ];
}

function defaultSpawnFn(args: string[], input: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      resolve({ stdout, code: code ?? 0 });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

function truncate(output: string): string {
  if (output.length <= OUTPUT_LIMIT) return output;
  return output.slice(0, OUTPUT_LIMIT) + TRUNCATION_SUFFIX;
}

export async function runBash(
  script: string,
  spawnFn: SpawnFn = defaultSpawnFn,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<SpawnResult> {
  let timeoutHandle: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("bash tool timed out"));
    }, timeoutMs);
  });

  let result: SpawnResult;
  try {
    result = await Promise.race([spawnFn(buildBashDockerArgs(), script), timeout]);
  } catch (err) {
    if (err instanceof Error && /ENOENT/.test(err.message)) {
      throw new Error(
        `bash tool failed: docker is not available (${err.message})`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle!);
  }

  return { stdout: truncate(result.stdout), code: result.code };
}

export const BASH_TOOL: Tool = createBashTool();

export function createBashTool(options?: {
  spawnFn?: SpawnFn;
  timeoutMs?: number;
}): Tool {
  return {
    name: "bash",
    description:
      "Run a shell command in a sandboxed docker container with no network access. " +
      "A scratch workspace is mounted read-write at /work; the repo is mounted read-only at /repo.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to run (bash) in the sandbox",
        },
      },
      required: ["command"],
    },
    async execute(args: unknown): Promise<string> {
      const { command } = (args ?? {}) as { command?: unknown };
      if (typeof command !== "string" || command.trim() === "") {
        throw new Error("bash requires a non-empty 'command' string");
      }
      const { stdout, code } = await runBash(command, options?.spawnFn, options?.timeoutMs);
      if (code !== 0) {
        throw new Error(`bash command exited with code ${code}: ${stdout}`);
      }
      return stdout;
    },
  };
}
