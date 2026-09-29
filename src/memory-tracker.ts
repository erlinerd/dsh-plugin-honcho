import { createHash } from "node:crypto";
import { sanitizeText } from "./domain/bounds.js";
import type {
  Clock,
  HonchoClient,
  IdGenerator,
  MemoryTurn,
  OutboxStore,
  SessionEventInput,
  TrackerConfig,
} from "./domain/types.js";

export interface MemoryTrackerDeps {
  outbox: OutboxStore;
  client: HonchoClient;
  config: TrackerConfig;
  clock: Clock;
  ids: IdGenerator;
}

interface TurnBuffer {
  turnNumber: number | null;
  turnId: string;
  startedAtMs: number;
  prompt: string | null;
  assistantMessage: string | null;
}

function honchoSessionId(sourceSessionId: string): string {
  const digest = createHash("sha256").update(sourceSessionId).digest("hex");
  return `dsh-${digest.slice(0, 32)}`;
}

function idempotencyKey(sourceSessionId: string, turnId: string): string {
  return createHash("sha256").update(`${sourceSessionId}:${turnId}`).digest("hex");
}

function textOfContent(content: unknown): string | null {
  if (typeof content === "string") return content || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

/**
 * In-process turn assembler, ported from zcode-plugin-honcho's hook flow:
 * the human prompt is captured first-wins (synthetic runtime-context and
 * system-reminder user-role events arrive after it), the assistant text
 * last-wins, and each closed turn lands in the durable outbox before an
 * asynchronous bounded upload is kicked off. Uploads never block or throw
 * into the session event loop; failures stay queued for the next retry.
 */
export class MemoryTracker {
  private readonly outbox: OutboxStore;
  private readonly client: HonchoClient;
  private readonly config: TrackerConfig;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly buffers = new Map<string, TurnBuffer | null>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: MemoryTrackerDeps) {
    this.outbox = deps.outbox;
    this.client = deps.client;
    this.config = deps.config;
    this.clock = deps.clock;
    this.ids = deps.ids;
  }

  pendingCount(): number {
    return this.inFlight.size;
  }

  drop(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  ingest(sessionId: string, event: SessionEventInput): void {
    if (!this.config.enabled) return;
    const data =
      event.data !== null && typeof event.data === "object"
        ? (event.data as Record<string, unknown>)
        : {};
    const time = typeof event.time === "number" ? event.time : Date.now();

    switch (event.type) {
      case "user/message": {
        const buffer = this.openBuffer(sessionId, time);
        // data IS the UserMessage (dsh contract); tolerate a wrapper. Only the
        // human prompt (source.kind "user") is captured: synthetic injected
        // contexts (honcho-recall, runtime-context, skill-catalog, …) arrive
        // as user-role events too and would otherwise shadow the real prompt.
        const message = (data.message ?? data) as { content?: unknown; source?: { kind?: unknown } } | null;
        const kind = message?.source && typeof message.source === "object" ? (message.source as { kind?: unknown }).kind : undefined;
        if (kind !== undefined && kind !== "user") return;
        const text = textOfContent(message?.content);
        if (this.config.capturePrompts && text !== null && buffer.prompt === null) {
          buffer.prompt = sanitizeText(text, this.config.maxCaptureChars);
        }
        return;
      }
      case "assistant/message": {
        const buffer = this.openBuffer(sessionId, time);
        const message = (data.message ?? null) as { content?: unknown } | null;
        const text = textOfContent(message?.content);
        if (this.config.captureResponses && text !== null) {
          buffer.assistantMessage = sanitizeText(text, this.config.maxCaptureChars);
        }
        return;
      }
      case "turn/end": {
        const buffer = this.buffers.get(sessionId);
        if (!buffer) return;
        this.buffers.set(sessionId, null);
        const turnNumber = typeof data.turn === "number" ? data.turn : buffer.turnNumber;
        const turnId = turnNumber !== null ? String(turnNumber) : buffer.turnId;
        const turn: MemoryTurn = {
          idempotencyKey: idempotencyKey(sessionId, turnId),
          sourceSessionId: sessionId,
          honchoSessionId: honchoSessionId(sessionId),
          turnId,
          userPeerId: this.config.peerId,
          assistantPeerId: this.config.assistantPeerId,
          prompt: buffer.prompt,
          assistantMessage: buffer.assistantMessage,
          startedAt: new Date(buffer.startedAtMs).toISOString(),
          endedAt: new Date(time).toISOString(),
        };
        if (turn.prompt === null && turn.assistantMessage === null) return;
        const enqueue = this.outbox.enqueue(turn);
        this.track(
          enqueue.then(() => this.flushPending(FLUSH_BUDGET_MS)),
          "turn upload",
        );
        return;
      }
      default:
        return;
    }
  }

  /** Upload everything queued; returns how many entries remain pending. */
  async flushPending(budgetMs: number): Promise<number> {
    const deadline = this.clock.now().getTime() + budgetMs;
    const entries = await this.outbox.pending();
    let delivered = 0;
    for (const entry of entries) {
      if (this.clock.now().getTime() >= deadline) break;
      try {
        await this.client.addTurn(entry);
        await this.outbox.remove(entry.idempotencyKey);
        delivered += 1;
      } catch {
        // Keep the failed entry pending and keep trying the rest while the
        // budget lasts, so one poisoned entry cannot starve the others.
      }
    }
    return entries.length - delivered;
  }

  /** Drains in-flight flush cycles within the budget (shutdown path). */
  async shutdown(budgetMs = 5_000): Promise<void> {
    if (this.inFlight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        // allSettled accepts the Set directly; it never rejects.
        Promise.allSettled(this.inFlight),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, budgetMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private track(promise: Promise<unknown>, what: string): void {
    const wrapped = promise.catch(() => {
      // Upload failures stay queued; nothing may escape into the event loop.
    }) as Promise<void>;
    this.inFlight.add(wrapped);
    void wrapped.finally(() => {
      this.inFlight.delete(wrapped);
    });
    void what;
  }

  private openBuffer(sessionId: string, time: number): TurnBuffer {
    const existing = this.buffers.get(sessionId);
    if (existing) return existing;
    const created: TurnBuffer = {
      turnNumber: null,
      turnId: this.ids.next(),
      startedAtMs: time,
      prompt: null,
      assistantMessage: null,
    };
    this.buffers.set(sessionId, created);
    return created;
  }
}

const FLUSH_BUDGET_MS = 10_000;
