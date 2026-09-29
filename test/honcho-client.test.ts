import { describe, expect, it } from "vitest";
import { HonchoSdkClient, NoopHonchoClient } from "../src/honcho-client.js";
import type { MemoryTurn } from "../src/domain/types.js";

const clientConfig = {
  apiKey: "test-key",
  baseURL: "https://honcho.example",
  workspaceId: "workspace-1",
};

const turn: MemoryTurn = {
  idempotencyKey: "memory-key",
  sourceSessionId: "source-session",
  honchoSessionId: "dsh-digest1",
  turnId: "1",
  userPeerId: "lei",
  assistantPeerId: "dsh",
  prompt: "I prefer concise answers.",
  assistantMessage: "Understood.",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:01:00.000Z",
};

function recordingFactory() {
  const calls: { peers: unknown[]; sessions: Array<{ id: string; options?: unknown }>; messages: unknown[]; contexts: string[] } = {
    peers: [],
    sessions: [],
    messages: [],
    contexts: [],
  };
  const factory = (options: { apiKey: string; baseURL: string; workspaceId: string }) => {
    calls.peers.push(options);
    return {
      peer: async (id: string) => ({
        id,
        message: (content: string, opts?: Record<string, unknown>) => ({ peerId: id, content, opts }),
        context: async () => {
          calls.contexts.push(id);
          if (id === "lei") {
            return {
              representation: "Prefers concise answers.",
              peerCard: ["Works in TypeScript", "Dislikes verbosity"],
            };
          }
          return { representation: null, peerCard: null };
        },
      }),
      session: async (id: string, options?: Record<string, unknown>) => {
        calls.sessions.push({ id, options });
        return {
          addMessages: async (messages: unknown[]) => {
            calls.messages.push(...messages);
          },
        };
      },
    };
  };
  return { factory, calls };
}

describe("HonchoSdkClient", () => {
  it("requires credentials and workspace at construction", () => {
    expect(
      () =>
        new HonchoSdkClient(
          { apiKey: "k", baseURL: "https://x", workspaceId: null },
          () => {
            throw new Error("should not be constructed");
          },
        ),
    ).toThrow(/workspace/i);
  });

  it("passes credentials and workspace to the SDK", async () => {
    const { factory, calls } = recordingFactory();
    new HonchoSdkClient(clientConfig, factory);
    expect(calls.peers[0]).toMatchObject({
      apiKey: "test-key",
      baseURL: "https://honcho.example",
      workspaceId: "workspace-1",
      timeout: 5_000,
      maxRetries: 0,
    });
  });

  it("attributes both sides of a turn and preserves the idempotency key", async () => {
    const { factory, calls } = recordingFactory();
    const client = new HonchoSdkClient(clientConfig, factory);
    await client.addTurn(turn);

    expect(calls.sessions).toHaveLength(1);
    const session = calls.sessions[0]!;
    expect(session.id).toBe("dsh-digest1");
    const options = session.options as { peers: Array<{ id: string }>; metadata: Record<string, unknown> };
    expect(options.peers.map((p) => p.id)).toEqual(["lei", "dsh"]);
    expect(options.metadata).toMatchObject({ memoryKey: "memory-key" });

    expect(calls.messages).toHaveLength(2);
    const userMessage = calls.messages[0] as { peerId: string; content: string; opts?: { metadata?: Record<string, unknown>; createdAt?: string } };
    const assistantMessage = calls.messages[1] as typeof userMessage;
    expect(userMessage.peerId).toBe("lei");
    expect(userMessage.content).toBe("I prefer concise answers.");
    expect(userMessage.opts?.metadata).toMatchObject({ memoryKey: "memory-key", turnId: "1" });
    expect(userMessage.opts?.createdAt).toBe(turn.startedAt);
    expect(assistantMessage.peerId).toBe("dsh");
    expect(assistantMessage.opts?.createdAt).toBe(turn.endedAt);
  });

  it("skips empty sides instead of sending blank messages", async () => {
    const { factory, calls } = recordingFactory();
    const client = new HonchoSdkClient(clientConfig, factory);
    await client.addTurn({ ...turn, prompt: null, assistantMessage: null });
    expect(calls.messages).toHaveLength(0);
  });

  it("formats recall context from peer card and representation", async () => {
    const { factory } = recordingFactory();
    const client = new HonchoSdkClient(clientConfig, factory);
    const context = await client.getContext({ peerId: "lei", assistantPeerId: "dsh" });
    expect(context).toContain("Known user context:");
    expect(context).toContain("- Works in TypeScript");
    expect(context).toContain("Learned representation:");
    expect(context).toContain("Prefers concise answers.");
  });

  it("returns null when the peer has nothing learned", async () => {
    const { factory } = recordingFactory();
    const client = new HonchoSdkClient(clientConfig, factory);
    await expect(client.getContext({ peerId: "stranger", assistantPeerId: "dsh" })).resolves.toBeNull();
  });
});

describe("NoopHonchoClient", () => {
  it("never throws and never recalls", async () => {
    const client = new NoopHonchoClient();
    await expect(client.addTurn(turn)).resolves.toBeUndefined();
    await expect(client.getContext({ peerId: "lei", assistantPeerId: "dsh" })).resolves.toBeNull();
  });
});
