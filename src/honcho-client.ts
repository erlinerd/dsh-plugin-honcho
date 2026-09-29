import { Honcho } from "@honcho-ai/sdk";
import type { HonchoClient, MemoryTurn } from "./domain/types.js";

type HonchoPeer = {
  id: string;
  message: (
    content: string,
    options?: { metadata?: Record<string, unknown>; createdAt?: string },
  ) => unknown;
  context: (options?: { maxConclusions?: number }) => Promise<{
    representation: string | null;
    peerCard: string[] | null;
  }>;
};

type HonchoSession = {
  addMessages: (messages: unknown[]) => Promise<unknown>;
};

type HonchoApi = {
  peer: (id: string) => Promise<HonchoPeer>;
  session: (
    id: string,
    options?: { peers?: unknown[]; metadata?: Record<string, unknown> },
  ) => Promise<HonchoSession>;
};

type HonchoFactory = (options: {
  apiKey: string;
  baseURL: string;
  workspaceId: string;
  timeout: number;
  maxRetries: number;
}) => HonchoApi;

export interface HonchoClientOptions {
  apiKey: string;
  baseURL: string;
  workspaceId: string | null;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function formatContext(context: {
  representation: string | null;
  peerCard: string[] | null;
}): string | null {
  const sections: string[] = [];
  if (context.peerCard?.length) {
    sections.push(
      `Known user context:\n${context.peerCard.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  if (context.representation?.trim())
    sections.push(`Learned representation:\n${context.representation.trim()}`);
  return sections.length ? sections.join("\n\n") : null;
}

/** Marker carried in Honcho metadata so uploads are attributable per harness. */
const SOURCE = "dsh";

/**
 * Honcho SDK adapter ported from zcode-plugin-honcho: per-turn attribution to
 * a user peer and an assistant peer inside one stable per-source-session
 * Honcho session, plus the bounded peer-context query used for recall.
 */
export class HonchoSdkClient implements HonchoClient {
  private readonly api: HonchoApi;

  constructor(
    config: HonchoClientOptions,
    factory: HonchoFactory = (options) => {
      // SAFETY: Honcho implements the subset represented by this structural test seam.
      return new Honcho(options) as unknown as HonchoApi;
    },
  ) {
    if (!config.apiKey || !config.workspaceId)
      throw new Error("Honcho client requires credentials and workspace");
    this.api = factory({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      workspaceId: config.workspaceId,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }

  async addTurn(turn: MemoryTurn): Promise<void> {
    const [user, assistant] = await Promise.all([
      this.api.peer(turn.userPeerId),
      this.api.peer(turn.assistantPeerId),
    ]);
    const session = await this.api.session(turn.honchoSessionId, {
      peers: [user, assistant],
      metadata: { source: SOURCE, memoryKey: turn.idempotencyKey },
    });
    const metadata = {
      source: SOURCE,
      turnId: turn.turnId,
      memoryKey: turn.idempotencyKey,
    };
    const messages: unknown[] = [];
    if (turn.prompt)
      messages.push(
        user.message(turn.prompt, { metadata, createdAt: turn.startedAt }),
      );
    if (turn.assistantMessage)
      messages.push(
        assistant.message(turn.assistantMessage, {
          metadata,
          createdAt: turn.endedAt,
        }),
      );
    if (messages.length) await session.addMessages(messages);
  }

  async getContext(input: {
    peerId: string;
    assistantPeerId: string;
  }): Promise<string | null> {
    const peer = await this.api.peer(input.peerId);
    return formatContext(await peer.context({ maxConclusions: 32 }));
  }
}

export class NoopHonchoClient implements HonchoClient {
  async addTurn(_turn: MemoryTurn): Promise<void> {
    return;
  }

  async getContext(_input: {
    peerId: string;
    assistantPeerId: string;
  }): Promise<string | null> {
    return null;
  }
}
