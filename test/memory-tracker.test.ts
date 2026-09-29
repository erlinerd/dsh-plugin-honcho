import { describe, expect, it } from "vitest";
import { MemoryTracker, type MemoryTrackerDeps } from "../src/memory-tracker.js";
import type { MemoryTurn, SessionEventInput, TrackerConfig } from "../src/domain/types.js";

class QueueOutbox {
  readonly enqueued: MemoryTurn[] = [];
  async enqueue(turn: MemoryTurn): Promise<void> {
    this.enqueued.push(turn);
  }
  async pending(): Promise<MemoryTurn[]> {
    return [...this.enqueued];
  }
  async remove(key: string): Promise<void> {
    const index = this.enqueued.findIndex((t) => t.idempotencyKey === key);
    if (index >= 0) this.enqueued.splice(index, 1);
  }
}

class ScriptedClient {
  readonly added: MemoryTurn[] = [];
  failNext = 0;
  async addTurn(turn: MemoryTurn): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("honcho down");
    }
    this.added.push(turn);
  }
  async getContext(): Promise<string | null> {
    return null;
  }
}

const baseConfig: TrackerConfig = {
  enabled: true,
  capturePrompts: true,
  captureResponses: true,
  maxCaptureChars: 12_000,
  peerId: "lei",
  assistantPeerId: "dsh",
};

function event(seq: number, type: string, data: unknown, time = 1_000 + seq * 10): SessionEventInput {
  return { seq, type, time, data };
}

function createTracker(
  overrides: { config?: Partial<TrackerConfig>; outbox?: QueueOutbox; client?: ScriptedClient } = {},
): { tracker: MemoryTracker; outbox: QueueOutbox; client: ScriptedClient } {
  const outbox = overrides.outbox ?? new QueueOutbox();
  const client = overrides.client ?? new ScriptedClient();
  const deps: MemoryTrackerDeps = {
    outbox,
    client,
    config: { ...baseConfig, ...overrides.config },
    clock: { now: () => new Date(0) },
    ids: { next: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })() },
  };
  return { tracker: new MemoryTracker(deps), outbox, client };
}

function feedTurn(tracker: MemoryTracker, sessionId: string, promptText: string, assistantText: string, turn = 1): void {
  tracker.ingest(sessionId, event(0, "turn/start", { turn }));
  tracker.ingest(sessionId, event(1, "user/message", { content: [{ type: "text", text: promptText }] }));
  tracker.ingest(
    sessionId,
    event(2, "assistant/message", { message: { content: [{ type: "text", text: assistantText }] }, usage: { inputTokens: 1, outputTokens: 1 } }),
  );
  tracker.ingest(sessionId, event(3, "turn/end", { turn, reason: { kind: "completed" } }));
}

describe("MemoryTracker", () => {
  it("assembles a turn pair into the outbox with dsh attribution", async () => {
    const { tracker, outbox } = createTracker();
    feedTurn(tracker, "s1", "remember this", "noted", 7);

    expect(outbox.enqueued).toHaveLength(1);
    const turn = outbox.enqueued[0]!;
    expect(turn.sourceSessionId).toBe("s1");
    expect(turn.turnId).toBe("7");
    expect(turn.userPeerId).toBe("lei");
    expect(turn.assistantPeerId).toBe("dsh");
    expect(turn.prompt).toBe("remember this");
    expect(turn.assistantMessage).toBe("noted");
    expect(turn.honchoSessionId).toMatch(/^dsh-[0-9a-f]{32}$/);
    // Same source session always maps to the same Honcho session.
    feedTurn(tracker, "s1", "again", "sure", 8);
    expect(outbox.enqueued[1]!.honchoSessionId).toBe(turn.honchoSessionId);
    // Idempotency keys differ per turn.
    expect(turn.idempotencyKey).not.toBe(outbox.enqueued[1]!.idempotencyKey);
  });

  it("captures nothing when the plugin is disabled or capture flags are off", async () => {
    const disabled = createTracker({ config: { enabled: false } });
    feedTurn(disabled.tracker, "s1", "p", "a");
    expect(disabled.outbox.enqueued).toHaveLength(0);

    const noPrompts = createTracker({ config: { capturePrompts: false } });
    feedTurn(noPrompts.tracker, "s1", "secret", "reply");
    expect(noPrompts.outbox.enqueued[0]!.prompt).toBeNull();
    expect(noPrompts.outbox.enqueued[0]!.assistantMessage).toBe("reply");

    const noResponses = createTracker({ config: { captureResponses: false } });
    feedTurn(noResponses.tracker, "s1", "hello", "quiet");
    expect(noResponses.outbox.enqueued[0]!.assistantMessage).toBeNull();
    expect(noResponses.outbox.enqueued[0]!.prompt).toBe("hello");
  });

  it("truncates over-budget text with the explicit marker", async () => {
    const { tracker, outbox } = createTracker({ config: { maxCaptureChars: 50 } });
    feedTurn(tracker, "s1", "p".repeat(200), "a".repeat(200));
    const turn = outbox.enqueued[0]!;
    expect(turn.prompt!.length).toBe(50);
    expect(turn.prompt!.endsWith("… [truncated]")).toBe(true);
    expect(turn.assistantMessage!.length).toBe(50);
  });

  it("does not queue turns with nothing capturable", async () => {
    const { tracker, outbox } = createTracker({
      config: { capturePrompts: false, captureResponses: false },
    });
    feedTurn(tracker, "s1", "p", "a");
    expect(outbox.enqueued).toHaveLength(0);
  });

  it("flushes pending entries and keeps failures queued for retry", async () => {
    const outbox = new QueueOutbox();
    const client = new ScriptedClient();
    const { tracker } = createTracker({ outbox, client });
    outbox.enqueued.push(
      { ...emptyTurn(), idempotencyKey: "k1" },
      { ...emptyTurn(), idempotencyKey: "k2" },
      { ...emptyTurn(), idempotencyKey: "k3" },
    );
    client.failNext = 1; // first addTurn fails, the rest must still be tried

    const failed = await tracker.flushPending(5_000);
    expect(client.added.map((t) => t.idempotencyKey)).toEqual(["k2", "k3"]);
    expect(failed).toBe(1);
    expect(outbox.enqueued.map((t) => t.idempotencyKey)).toEqual(["k1"]);
  });

  it("respects the flush budget and reports the remainder", async () => {
    const outbox = new QueueOutbox();
    const { tracker } = createTracker({ outbox });
    for (const key of ["b1", "b2", "b3"]) outbox.enqueued.push({ ...emptyTurn(), idempotencyKey: key });
    // Budget 0: nothing is attempted.
    const failed = await tracker.flushPending(0);
    expect(failed).toBe(3);
  });

  it("drops buffered state on session disposal", () => {
    const { tracker, outbox } = createTracker();
    tracker.ingest("s1", event(0, "turn/start", { turn: 1 }));
    tracker.ingest("s1", event(1, "user/message", { content: [{ type: "text", text: "p" }] }));
    tracker.drop("s1");
    tracker.ingest("s1", event(2, "turn/end", { turn: 1, reason: { kind: "completed" } }));
    expect(outbox.enqueued).toHaveLength(0);
  });

  it("captures only the human prompt — synthetic injected contexts are skipped", async () => {
    const { tracker, outbox } = createTracker();
    // Real log shapes: recall injection lands BEFORE the human prompt.
    const recall = { content: [{ type: "text", text: "<honcho-recall> Known user context </honcho-recall>" }], source: { kind: "honcho-recall", form: "recall" } };
    const human = { content: [{ type: "text", text: "the human prompt" }], source: { kind: "user" } };
    const runtime = { content: [{ type: "text", text: "runtime context snapshot" }], source: { kind: "runtime-context", form: "snapshot" } };
    tracker.ingest("s1", event(0, "turn/start", { turn: 1 }));
    tracker.ingest("s1", event(1, "user/message", recall));
    tracker.ingest("s1", event(2, "user/message", human));
    tracker.ingest("s1", event(3, "user/message", runtime));
    tracker.ingest("s1", event(4, "turn/end", { turn: 1, reason: { kind: "completed" } }));
    expect(outbox.enqueued[0]!.prompt).toBe("the human prompt");
  });

  it("ignores unknown events and malformed data without throwing", () => {
    const { tracker, outbox } = createTracker();
    expect(() => {
      tracker.ingest("s1", event(0, "some/future-event", { x: 1 }));
      tracker.ingest("s1", event(1, "user/message", null));
      tracker.ingest("s1", event(2, "turn/end", null));
    }).not.toThrow();
    expect(outbox.enqueued).toHaveLength(0);
  });
});

function emptyTurn(): MemoryTurn {
  return {
    idempotencyKey: "",
    sourceSessionId: "s",
    honchoSessionId: "dsh-x",
    turnId: "1",
    userPeerId: "lei",
    assistantPeerId: "dsh",
    prompt: "p",
    assistantMessage: "a",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:00.000Z",
  };
}
