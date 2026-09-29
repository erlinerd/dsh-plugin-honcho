import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonOutboxStore } from "../src/outbox.js";
import { withFileLock } from "../src/file-lock.js";
import type { MemoryTurn } from "../src/domain/types.js";

let rootDir: string;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "honcho-outbox-"));
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

let storeCount = 0;
function makeStore(): { store: JsonOutboxStore; dir: string; entriesDir: string } {
  storeCount += 1;
  const dir = join(rootDir, `store-${storeCount}`);
  return { store: new JsonOutboxStore(dir), dir, entriesDir: join(dir, "entries") };
}

function makeTurn(overrides: Partial<MemoryTurn> = {}): MemoryTurn {
  return {
    idempotencyKey: "key-1",
    sourceSessionId: "session-1",
    honchoSessionId: "dsh-digest1",
    turnId: "1",
    userPeerId: "lei",
    assistantPeerId: "dsh",
    prompt: "hello",
    assistantMessage: "hi",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

describe("JsonOutboxStore", () => {
  it("enqueues and reads back pending turns", async () => {
    const { store } = makeStore();
    await store.enqueue(makeTurn({ idempotencyKey: "a" }));
    await store.enqueue(makeTurn({ idempotencyKey: "b", prompt: null }));

    const pending = await store.pending();
    expect(pending).toHaveLength(2);
    expect(pending.map((t) => t.idempotencyKey).sort()).toEqual(["a", "b"]);
    expect(pending.find((t) => t.idempotencyKey === "b")!.prompt).toBeNull();

    await store.remove("a");
    expect((await store.pending()).map((t) => t.idempotencyKey)).toEqual(["b"]);
  });

  it("is idempotent per key and orders by endedAt", async () => {
    const { store } = makeStore();
    await store.enqueue(makeTurn({ idempotencyKey: "order-1", endedAt: "2026-01-02T00:00:00.000Z" }));
    await store.enqueue(makeTurn({ idempotencyKey: "order-1" })); // duplicate: ignored
    await store.enqueue(makeTurn({ idempotencyKey: "order-0", endedAt: "2026-01-01T00:00:00.000Z" }));

    const pending = await store.pending();
    expect(pending.map((t) => t.idempotencyKey)).toEqual(["order-0", "order-1"]);
  });

  it("skips corrupt entries instead of failing the whole scan", async () => {
    const { store, entriesDir } = makeStore();
    await store.enqueue(makeTurn({ idempotencyKey: "good" }));
    // Plant corrupt files where an entry would live.
    writeFileSync(join(entriesDir, "garbage.json"), "{ not json");
    writeFileSync(join(entriesDir, "wrong-shape.json"), JSON.stringify({ nope: true }));

    const pending = await store.pending();
    expect(pending.map((t) => t.idempotencyKey)).toEqual(["good"]);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(entriesDir).filter((f) => f.endsWith(".json")).length).toBe(3);
  });

  it("serializes concurrent writers through the file lock", async () => {
    const { store, dir } = makeStore();
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.enqueue(makeTurn({ idempotencyKey: `lock-${i}` })).then(() => {
          // Re-enter through a locked section to observe mutual exclusion.
          return withFileLock(join(dir, "outbox.lock"), async () => {
            inside += 1;
            maxInside = Math.max(maxInside, inside);
            await new Promise((r) => setTimeout(r, 5));
            inside -= 1;
          });
        }),
      ),
    );
    expect(maxInside).toBe(1);
    expect((await store.pending()).length).toBeGreaterThanOrEqual(8);
  });
});

describe("withFileLock", () => {
  it("runs the task and releases the lock", async () => {
    const lockPath = join(rootDir, "case.lock");
    const result = await withFileLock(lockPath, async () => 42);
    expect(result).toBe(42);
    await expect(withFileLock(lockPath, async () => "second")).resolves.toBe("second");
  });

  it("times out fast when another holder never releases (injectable budget)", async () => {
    const lockPath = join(rootDir, "stuck.lock");
    let releaseAcquired: () => void = () => {};
    const acquired = new Promise<void>((resolve) => {
      releaseAcquired = resolve;
    });
    const blocker = withFileLock(
      lockPath,
      async () => {
        releaseAcquired(); // task runs only after the lock is held
        await new Promise(() => {});
      },
      { attempts: 2, waitMs: 5 },
    );
    await acquired;
    await expect(
      withFileLock(lockPath, async () => 1, { attempts: 2, waitMs: 5 }),
    ).rejects.toThrow(/lock/i);
    await rmSync(lockPath, { force: true });
    void blocker;
  }, 10_000);

  it("steals a stale lock older than the staleness budget", async () => {
    const lockPath = join(rootDir, "stale.lock");
    writeFileSync(lockPath, "");
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);
    await expect(
      withFileLock(lockPath, async () => "stolen", { attempts: 2, waitMs: 5 }),
    ).resolves.toBe("stolen");
  });
});
