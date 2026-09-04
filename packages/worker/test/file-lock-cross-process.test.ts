// The literal reproduction of the brief's A/B scenario: worker A and worker
// B are separate OS processes; both try to lock the same file path; A holds
// an exclusive lock while "editing"; B must get a clear wait-then-succeed or
// wait-then-fail outcome, never an indefinite hang and never silent
// corruption. Spawns two real `tsx` child processes (not two async
// functions in one process) sharing only Postgres, via
// test/support/file-lock-cli.ts.
//
//   DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test \
//     npx vitest run packages/worker/test/file-lock-cross-process.test.ts
//
// Slower than the rest of the suite (spawns real processes, real waits) -
// kept as its own file so it's easy to skip in a tight inner loop while
// still running in `npm run test:db`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, createPool, initSchema } from "@stateless-chat/shared";
import { canonicalLockKey } from "../src/tools/file-path-jail.js";
import { requireDisposableTestDatabase } from "./support/require-test-database.js";

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

requireDisposableTestDatabase(env.databaseUrl);

const pool = createPool();
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cliScript = path.join(here, "support", "file-lock-cli.ts");

beforeAll(async () => {
  await initSchema(pool);
  await pool.query("TRUNCATE file_locks");
}, 30_000);

afterAll(async () => {
  await pool.end();
});

interface CliResult {
  ok: boolean;
  result?: string;
  error?: string;
  elapsedMs: number;
  key: string;
}

function runCli(targetPath: string, holdMs: number, acquireTimeoutMs: number, leaseDurationMs?: number): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const args = [cliScript, targetPath, String(holdMs), String(acquireTimeoutMs)];
    if (leaseDurationMs !== undefined) args.push(String(leaseDurationMs));
    const child = spawn(tsxBin, args, {
      env: { ...process.env, DATABASE_URL: env.databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", () => {
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        reject(new Error(`file-lock-cli produced no output. stderr: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(new Error(`file-lock-cli produced non-JSON output: ${line}\nstderr: ${stderr}`));
      }
    });
  });
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-cross-process-"));
});

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("cross-process file lock: two real Node processes, same path", () => {
  it(
    "A holds the lock while 'editing'; B, requesting the same path, waits and then fails clearly once its bounded wait elapses - not an indefinite hang, not a silent overwrite",
    async () => {
      const target = path.join(tmpDir, "ab-timeout.txt");
      await fs.writeFile(target, "original");

      // A holds for 900ms; B only waits up to 300ms - B must time out with a
      // clear, actionable error well before A releases.
      const [a, b] = await Promise.all([
        runCli(target, 900, 5000),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return runCli(target, 0, 300);
        })(),
      ]);

      expect(a.ok).toBe(true);
      expect(a.result).toBe("held-ok");

      expect(b.ok).toBe(false);
      expect(b.error).toMatch(/Timed out.*waiting for a lock/);
      // Bounded wait, not immediate rejection and not an unbounded hang: B's
      // observed elapsed time is close to its own timeout budget, not ~0ms.
      expect(b.elapsedMs).toBeGreaterThanOrEqual(250);
      expect(b.elapsedMs).toBeLessThan(2000);
    },
    15_000
  );

  it(
    "A holds briefly; B waits with a generous budget and succeeds once A releases - the routine, non-pathological case",
    async () => {
      const target = path.join(tmpDir, "ab-wait-then-succeed.txt");
      await fs.writeFile(target, "original");

      const [a, b] = await Promise.all([
        runCli(target, 500, 5000),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return runCli(target, 0, 5000);
        })(),
      ]);

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      // B had to wait roughly until A released (~400ms remaining from its
      // point of view), not succeed immediately - proves real cross-process
      // mutual exclusion happened, not two independent successes.
      expect(b.elapsedMs).toBeGreaterThanOrEqual(300);
    },
    15_000
  );

  it("a crashed holder's lock is reclaimed by a waiting process once the lease expires, not held forever", async () => {
    const target = path.join(tmpDir, "ab-crash-reclaim.txt");
    await fs.writeFile(target, "original");
    const key = await canonicalLockKey(target);

    // A "crashes": holds for far longer than its own short lease and is
    // killed before it can release or renew - simulated by giving A a hold
    // time far beyond its lease, then SIGKILLing it mid-hold. Polls
    // Postgres directly for the row to appear/expire instead of guessing at
    // process-startup timing with blind sleeps, so this isn't sensitive to
    // how long `tsx` takes to boot and connect on a given machine.
    const leaseDurationMs = 300;
    const args = [cliScript, target, "10000", "5000", String(leaseDurationMs)];
    // `tsx` itself runs the script in a child Node process (a loader-boot
    // subprocess) rather than executing it in the process spawn() returns,
    // so killing only that returned PID leaves the actual work - and its
    // lease-renewal heartbeat - running. `detached: true` makes the spawned
    // process its own process-group leader, so killing the NEGATIVE pid
    // (the whole group) reaches the real worker process too, faithfully
    // reproducing an OS-level "the whole worker process tree is gone".
    const crashedChild = spawn(tsxBin, args, {
      env: { ...process.env, DATABASE_URL: env.databaseUrl },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });

    await waitUntil(async () => {
      const { rowCount } = await pool.query("SELECT 1 FROM file_locks WHERE lock_key = $1", [key]);
      return (rowCount ?? 0) > 0;
    }, 10_000);
    if (crashedChild.pid) process.kill(-crashedChild.pid, "SIGKILL");

    await waitUntil(async () => {
      const { rows } = await pool.query<{ expired: boolean }>(
        "SELECT expires_at < now() AS expired FROM file_locks WHERE lock_key = $1",
        [key]
      );
      return rows[0]?.expired === true;
    }, 10_000);

    const b = await runCli(target, 0, 5000);
    expect(b.ok).toBe(true);
  }, 20_000);

  it("two different spellings of the same real path resolve to the same lock key and genuinely contend", async () => {
    const real = path.join(tmpDir, "canonical-target.txt");
    await fs.writeFile(real, "original");
    const link = path.join(tmpDir, "canonical-alias.txt");
    await fs.symlink(real, link);

    const [a, b] = await Promise.all([
      runCli(real, 500, 5000),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return runCli(link, 0, 5000);
      })(),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.key).toBe(b.key);
    // If the symlink alias had taken out a DIFFERENT lock, b would have
    // succeeded immediately instead of waiting for a to release.
    expect(b.elapsedMs).toBeGreaterThanOrEqual(300);
  }, 15_000);
});
