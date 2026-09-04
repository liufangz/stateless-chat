// Standalone script (NOT a vitest test file) run as its own OS process by
// file-lock-cross-process.test.ts, to reproduce the user's literal A/B
// scenario across two genuinely separate Node processes sharing only
// Postgres (via DATABASE_URL) - not a Node heap. Reads args, acquires the
// real cross-process file lock for a target path, holds it for `holdMs`,
// then prints one JSON line describing the outcome and exits.
//
// Usage: tsx file-lock-cli.ts <targetPath> <holdMs> <acquireTimeoutMs> [leaseDurationMs]
import { createPostgresFileLock, withFileLock } from "../../src/tools/file-lock.js";
import { canonicalLockKey } from "../../src/tools/file-path-jail.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const [targetPath, holdMsRaw, acquireTimeoutMsRaw, leaseDurationMsRaw] = process.argv.slice(2);
  const holdMs = Number(holdMsRaw);
  const acquireTimeoutMs = Number(acquireTimeoutMsRaw);
  const leaseDurationMs = leaseDurationMsRaw ? Number(leaseDurationMsRaw) : undefined;

  const key = await canonicalLockKey(targetPath);
  const lock = createPostgresFileLock();
  const start = Date.now();

  try {
    const result = await withFileLock(key, () => sleep(holdMs).then(() => "held-ok"), {
      lock,
      acquireTimeoutMs,
      leaseDurationMs,
    });
    process.stdout.write(JSON.stringify({ ok: true, result, elapsedMs: Date.now() - start, key }) + "\n");
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - start,
        key,
      }) + "\n"
    );
  }
  process.exit(0);
}

void main();
