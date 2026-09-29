/**
 * Pure domain contracts ported from zcode-plugin-honcho v0.2.3, reshaped for
 * the in-process dsh event model. Everything here is serializable and IO-free.
 */

/** One user/assistant turn pair queued for Honcho upload. */
export interface MemoryTurn {
  idempotencyKey: string;
  sourceSessionId: string;
  honchoSessionId: string;
  turnId: string;
  userPeerId: string;
  assistantPeerId: string;
  prompt: string | null;
  assistantMessage: string | null;
  startedAt: string;
  endedAt: string;
}

/** Structural input for one canonical dsh session event (SessionEvent shape). */
export interface SessionEventInput {
  seq: number;
  type: string;
  /** Unix epoch milliseconds, from the event envelope. */
  time: number;
  data: unknown;
}

export interface TrackerConfig {
  enabled: boolean;
  capturePrompts: boolean;
  captureResponses: boolean;
  maxCaptureChars: number;
  peerId: string;
  assistantPeerId: string;
}

/** Honcho upload/query surface — the client may throw; callers contain. */
export interface HonchoClient {
  addTurn(turn: MemoryTurn): Promise<void>;
  getContext(input: { peerId: string; assistantPeerId: string }): Promise<string | null>;
}

/** Durable pending-upload queue. */
export interface OutboxStore {
  enqueue(turn: MemoryTurn): Promise<void>;
  /** Skips corrupt entries instead of failing the whole scan. */
  pending(): Promise<MemoryTurn[]>;
  remove(idempotencyKey: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
