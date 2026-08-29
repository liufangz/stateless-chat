import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several test files (db-lease.test.ts, turn-recovery.test.ts,
    // crash-recovery.e2e.test.ts) exercise real Postgres against a shared
    // disposable database and each TRUNCATEs its own tables in beforeAll.
    // Vitest runs test files in parallel by default, which lets one file's
    // TRUNCATE wipe rows another file's still-running tests depend on -
    // this isn't a flaky-test issue, it's genuine cross-file interference
    // on shared mutable DB state. Running files sequentially avoids it
    // without coupling the test files to each other.
    fileParallelism: false,
  },
});
