import { spawn } from "node:child_process";
import path from "node:path";
import type { Tool } from "../tool-loop.js";

const OUTPUT_LIMIT = 4000;
const TRUNCATION_SUFFIX = "\n...[output truncated]";
const DEFAULT_TIMEOUT_MS = 20_000;
// Full-host mode: run the shell as the normal host account rather than the
// former downgraded `opc` account. On this machine `ubuntu` has passwordless
// sudo and docker access, so this is intentionally not a sandbox.
const EXEC_USER = "ubuntu";

export const HOME_ROOT = "/home/ubuntu";
export const REPO_ROOT = "/home/ubuntu/stateless-chat";
export const DEFAULT_CWD = HOME_ROOT;

export interface SpawnResult {
  stdout: string;
  code: number;
}

export type SpawnFn = (args: string[], input: string) => Promise<SpawnResult>;

/**
 * Pure — returns the exact `sudo` argv used to run the command as ubuntu on
 * the host. Tests assert this array directly so the execution identity and
 * HOME cannot be silently changed. nodeBinDir is prepended to PATH so
 * `node`/`npm`/`npx` resolve even if the worker uses a different Node install.
 */
export function buildBashExecArgs(
  nodeBinDir: string = path.dirname(process.execPath)
): string[] {
  return [
    "-n",
    "-u",
    EXEC_USER,
    "--",
    "env",
    `HOME=${HOME_ROOT}`,
    `PATH=${nodeBinDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    "bash",
    "-s",
  ];
}

function defaultSpawnFn(args: string[], input: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", args, { cwd: DEFAULT_CWD, stdio: ["pipe", "pipe", "pipe"] });
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
    result = await Promise.race([spawnFn(buildBashExecArgs(), script), timeout]);
  } catch (err) {
    if (err instanceof Error && /ENOENT/.test(err.message)) {
      throw new Error(
        `bash tool failed: sudo is not available (${err.message})`
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
      "Run an unrestricted shell command on the host as ubuntu. This is NOT a sandbox: " +
      "ubuntu has passwordless sudo/docker access and commands may read or modify the " +
      "entire machine, not just /home/ubuntu. Default cwd and HOME: /home/ubuntu.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to run (bash) on the host",
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
