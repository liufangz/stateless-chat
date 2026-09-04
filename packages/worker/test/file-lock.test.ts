import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalLockKey } from "../src/tools/file-path-jail.js";
import { withFileLock, DEFAULT_ACQUIRE_TIMEOUT_MS } from "../src/tools/file-lock.js";
import { createAlwaysHeldFileLock, createFakeFileLock } from "./support/fake-file-lock.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-key-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("canonicalLockKey", () => {
  it("resolves an existing file to its realpath", async () => {
    const target = path.join(dir, "note.txt");
    await fs.writeFile(target, "hi");
    expect(await canonicalLockKey(target)).toBe(await fs.realpath(target));
  });

  it("a symlink alias and its real target converge to the same lock key", async () => {
    const target = path.join(dir, "note.txt");
    await fs.writeFile(target, "hi");
    const link = path.join(dir, "alias.txt");
    await fs.symlink(target, link);

    expect(await canonicalLockKey(link)).toBe(await canonicalLockKey(target));
  });

  it("a not-yet-existing target under an existing directory canonicalizes via the nearest existing ancestor", async () => {
    const target = path.join(dir, "new-file.txt");
    const key1 = await canonicalLockKey(target);
    const key2 = await canonicalLockKey(target);
    // Stable across repeated calls while the file still doesn't exist.
    expect(key1).toBe(key2);
    expect(key1).toBe(path.join(await fs.realpath(dir), "new-file.txt"));
  });

  it("a not-yet-existing target converges with its own eventual realpath once created", async () => {
    const target = path.join(dir, "new-file.txt");
    const keyBefore = await canonicalLockKey(target);
    await fs.writeFile(target, "now it exists");
    const keyAfter = await canonicalLockKey(target);
    expect(keyAfter).toBe(keyBefore);
    expect(keyAfter).toBe(await fs.realpath(target));
  });

  it("a not-yet-existing target reached through a symlinked parent directory still converges with the real target", async () => {
    const realParent = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-real-parent-"));
    const linkParent = path.join(dir, "linked-parent");
    await fs.symlink(realParent, linkParent);

    const viaLink = path.join(linkParent, "new-file.txt");
    const viaReal = path.join(realParent, "new-file.txt");
    expect(await canonicalLockKey(viaLink)).toBe(await canonicalLockKey(viaReal));

    await fs.rm(realParent, { recursive: true, force: true });
  });
});

describe("withFileLock", () => {
  it("runs fn while holding the lock and releases it afterward", async () => {
    const lock = createFakeFileLock();
    let ranWhileHeld = false;
    await withFileLock(
      "key-1",
      async () => {
        ranWhileHeld = await lock.acquire("key-1", "someone-else", 1000).then((ok) => !ok);
      },
      { lock }
    );
    expect(ranWhileHeld).toBe(true);
    // Released - a fresh acquire now succeeds.
    expect(await lock.acquire("key-1", "someone-else", 1000)).toBe(true);
  });

  it("releases the lock even when fn throws", async () => {
    const lock = createFakeFileLock();
    await expect(
      withFileLock(
        "key-1",
        async () => {
          throw new Error("boom");
        },
        { lock }
      )
    ).rejects.toThrow("boom");
    expect(await lock.acquire("key-1", "someone-else", 1000)).toBe(true);
  });

  it("retries with backoff and eventually succeeds once the lock frees up", async () => {
    const held = new Map<string, string>();
    held.set("key-1", "other-owner");
    let attempts = 0;
    const lock = {
      async acquire(key: string, owner: string) {
        attempts++;
        if (attempts < 3) return false;
        held.set(key, owner);
        return true;
      },
      async renew() {
        return true;
      },
      async release() {},
    };
    const result = await withFileLock("key-1", async () => "done", { lock, acquireTimeoutMs: 5000 });
    expect(result).toBe("done");
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("times out with a clear, actionable error instead of hanging indefinitely", async () => {
    const lock = createAlwaysHeldFileLock();
    await expect(
      withFileLock("key-1", async () => "unreachable", { lock, acquireTimeoutMs: 50 })
    ).rejects.toThrow(/Timed out after 50ms waiting for a lock on 'key-1'/);
  });

  it("has a sane default acquire timeout well under the tool loop's own per-turn budget", () => {
    // Documents the intentional bound - see file-lock.ts's comment on why
    // this must comfortably outlast a routine ~1-minute edit without
    // approaching the 600s tool-loop deadline.
    expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBeLessThan(600_000);
  });

  it("renews the held lock on a heartbeat during a long-running fn", async () => {
    vi.useFakeTimers();
    try {
      const lock = createFakeFileLock();
      const renewSpy = vi.spyOn(lock, "renew");
      const holdPromise = withFileLock(
        "key-1",
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 20_000);
          }),
        { lock, leaseDurationMs: 3000 }
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await holdPromise;
      expect(renewSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("lease loss mid-hold (a reclaimed lock is never silently treated as still ours)", () => {
    it("rejects instead of returning fn's result once a renewal explicitly reports the lock is gone - even if fn already finished 'successfully'", async () => {
      vi.useFakeTimers();
      try {
        // Simulates: our lease expired mid-operation (e.g. this process
        // stalled), another owner's acquire() won it, and our next renewal
        // attempt correctly reports `false`. `fn` itself has no idea and
        // runs to completion regardless - withFileLock must not let that
        // completion be reported as a trustworthy success.
        const lock = {
          async acquire() {
            return true;
          },
          async renew() {
            return false; // definitively: someone else owns it now
          },
          async release() {},
        };
        const holdPromise = withFileLock(
          "key-1",
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve("looked successful"), 20_000);
            }),
          { lock, leaseDurationMs: 3000 }
        );
        const assertion = expect(holdPromise).rejects.toThrow(/reclaimed by another owner/);
        await vi.advanceTimersByTimeAsync(20_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not call release() once lease loss is known - it would be a guaranteed no-op against the new owner's lock", async () => {
      vi.useFakeTimers();
      try {
        const releaseSpy = vi.fn(async () => {});
        const lock = {
          async acquire() {
            return true;
          },
          async renew() {
            return false;
          },
          release: releaseSpy,
        };
        const holdPromise = withFileLock(
          "key-1",
          () => new Promise((resolve) => setTimeout(() => resolve("x"), 20_000)),
          { lock, leaseDurationMs: 3000 }
        );
        const assertion = expect(holdPromise).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(20_000);
        await assertion;
        expect(releaseSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a transient renewal failure (rejected promise, not an explicit false) is NOT treated as lease loss", async () => {
      vi.useFakeTimers();
      try {
        let renewCalls = 0;
        const lock = {
          async acquire() {
            return true;
          },
          async renew() {
            renewCalls++;
            throw new Error("ECONNRESET"); // a network blip, not "someone else owns it"
          },
          async release() {},
        };
        const holdPromise = withFileLock(
          "key-1",
          () => new Promise((resolve) => setTimeout(() => resolve("ok"), 20_000)),
          { lock, leaseDurationMs: 3000 }
        );
        await vi.advanceTimersByTimeAsync(20_000);
        await expect(holdPromise).resolves.toBe("ok");
        expect(renewCalls).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("fn can proactively check ctx.isLeaseLost() and abort BEFORE its own mutating step, once loss is detected", async () => {
      vi.useFakeTimers();
      try {
        const lock = {
          async acquire() {
            return true;
          },
          async renew() {
            return false;
          },
          async release() {},
        };
        let mutated = false;
        const holdPromise = withFileLock(
          "key-1",
          async (ctx) => {
            // Simulate work happening in between, giving the heartbeat a
            // chance to fire and observe the lease is gone.
            await new Promise((resolve) => setTimeout(resolve, 6000));
            if (ctx.isLeaseLost()) {
              throw new Error("aborted before mutating: lease lost");
            }
            mutated = true;
            return "wrote";
          },
          { lock, leaseDurationMs: 3000 }
        );
        const assertion = expect(holdPromise).rejects.toThrow(/aborted before mutating/);
        await vi.advanceTimersByTimeAsync(6000);
        await assertion;
        expect(mutated).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
