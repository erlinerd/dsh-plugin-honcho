import { randomUUID } from "node:crypto";
import { Service, type Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { resolveCredentials, type Credentials } from "./credentials.js";
import { HonchoSdkClient, NoopHonchoClient } from "./honcho-client.js";
import { JsonOutboxStore } from "./outbox.js";
import { MemoryTracker, type MemoryTrackerDeps } from "./memory-tracker.js";
import { sanitizeText } from "./domain/bounds.js";
import type { Clock, HonchoClient, IdGenerator, OutboxStore, SessionEventInput } from "./domain/types.js";

/** Resolved shape of `HonchoPlugin.Config` (see the schema below). */
export interface HonchoConfig {
  baseUrl: string;
  workspaceId?: string | null;
  peerId: string;
  assistantPeerId: string;
  enabled: boolean;
  injectContext: boolean;
  capturePrompts: boolean;
  captureResponses: boolean;
  maxContextChars: number;
  maxCaptureChars: number;
  debug: boolean;
}

export interface WireContext {
  logger: { warn(message: string): void };
  on(name: "session/created", handler: (session: { id: unknown }) => void): void;
  on(name: "session/event", handler: (session: { id: unknown }, event: SessionEventInput) => void): void;
  on(name: "session/disposed", handler: (session: { id: unknown }) => void): void;
  on(
    name: "agent/created",
    handler: (payload: {
      agent?: {
        session?: { id: unknown };
        /** Runtime facade: inject sits on the agent (dsh-agent-loop ReactLoopAgent). */
        inject?(message: unknown): void;
      };
    }) => unknown,
  ): void;
  effect(dispose: () => unknown, name?: string): void;
}

export interface WireDeps {
  /** Defaults to resolveCredentials(process.env); explicit null disables. */
  credentials?: Credentials | null;
  client?: HonchoClient;
  tracker?: MemoryTracker;
  outbox?: OutboxStore;
  /** Recall round-trip budget inside the awaited agent/created listener. */
  recallBudgetMs?: number;
}

const RETRY_BUDGET_MS = 5_000;
const RECALL_BUDGET_MS = 3_000;

/** Structural equivalent of dsh-llm's createUserMessage output (dependency-free). */
export interface InjectedUserMessage {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly source: Record<string, unknown>;
  readonly role: "user";
  readonly id: string;
}

function userMessage(text: string, source: Record<string, unknown>): InjectedUserMessage {
  // Structural equivalent of dsh-llm's createUserMessage (clone + uuid + role),
  // kept dependency-free on purpose.
  const message: InjectedUserMessage = {
    content: [{ type: "text", text }],
    source,
    role: "user",
    id: randomUUID(),
  };
  return Object.freeze(structuredClone(message));
}

function raceBudget<T>(task: Promise<T>, budgetMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    task,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Install the Honcho memory loop onto a context, in the
 * dsh-plugin-langfuse containment style: every subscription is self-contained
 * (cordis `emit` is stop-on-throw) and the awaited `agent/created` recall
 * listener never throws (a throw would fail agent creation).
 *
 * recall injection — investigated per SPEC candidates and resolved to the
 * native per-agent inject: `agent/created` fires before the first request
 * (AgentLoop holds queued input until its listeners finish, so recall lands
 * before the first model call, matching zcode's SessionStart semantics), and
 * `agent.inject()` queues durable model-facing context without waking
 * the driver — the same channel dsh itself uses for synthetic contexts.
 * SPEC candidate ① (dsh-system-prompt sections) is per-agent-scoped only
 * through agent.ctx and would leak one session's recall into the global
 * system prompt; candidate ② (dsh-agent-instructions baseline) has no
 * external contribution API; candidate ③ (dsh-hook-protocol attach-context)
 * is documented as "avoid for bespoke behavior — a native Cordis plugin has
 * the full harness API". Capture-only fallback applies if recall fails.
 */
export function wireHoncho(ctx: WireContext, config: HonchoConfig, deps: WireDeps = {}): void {
  const credentials = deps.credentials === undefined ? resolveCredentials({ env: process.env }) : deps.credentials;
  if (!credentials) {
    if (config.debug) {
      ctx.logger.warn("honcho: no credentials found (HONCHO_API_KEY env or $DSH_HOME/honcho.json); plugin disabled");
    }
    return;
  }
  // honcho.json overrides win over patch config: the file is the freshest
  // machine-local statement of intent (README deviation #2).
  const workspaceId = credentials.workspaceId ?? config.workspaceId ?? null;
  if (!workspaceId) {
    if (config.debug) {
      ctx.logger.warn("honcho: no workspaceId resolved (config.workspaceId or honcho.json); plugin disabled");
    }
    return;
  }
  const baseUrl = credentials.baseUrl ?? config.baseUrl;
  const peerId = credentials.peerId ?? config.peerId;

  let client: HonchoClient;
  try {
    client =
      deps.client ??
      new HonchoSdkClient({ apiKey: credentials.apiKey, baseURL: baseUrl, workspaceId });
  } catch (error) {
    if (config.debug) {
      ctx.logger.warn(`honcho: client unavailable (${error instanceof Error ? error.message : String(error)}); plugin disabled`);
    }
    return;
  }
  const noop = client instanceof NoopHonchoClient;

  const tracker =
    deps.tracker ??
    new MemoryTracker({
      outbox: deps.outbox ?? new JsonOutboxStore(),
      client,
      config: {
        enabled: config.enabled,
        capturePrompts: config.capturePrompts,
        captureResponses: config.captureResponses,
        maxCaptureChars: config.maxCaptureChars,
        peerId,
        assistantPeerId: config.assistantPeerId,
      },
      clock: { now: () => new Date() } satisfies Clock,
      ids: { next: randomUUID } satisfies IdGenerator,
    } satisfies MemoryTrackerDeps);
  void noop;

  const contain = (what: string, step: () => unknown): void => {
    try {
      const result = step();
      if (result instanceof Promise) {
        void result.catch((error: unknown) => {
          ctx.logger.warn(`honcho: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } catch (error) {
      ctx.logger.warn(`honcho: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  ctx.on("session/created", () =>
    contain("session/created", () => {
      // Next session start: retry whatever the previous runs left queued.
      void tracker.flushPending(RETRY_BUDGET_MS);
    }),
  );
  ctx.on("session/event", (session, event) =>
    contain("session/event", () => {
      tracker.ingest(String(session.id), event);
    }),
  );
  ctx.on("session/disposed", (session) => contain("session/disposed", () => tracker.drop(String(session.id))));

  ctx.on("agent/created", (payload) => {
    // Awaited by agent creation: contain everything, never throw, stay inside
    // the budget so a slow Honcho cannot stall the first model call.
    return containAsync("agent recall", async () => {
      const agent = payload.agent;
      if (!config.enabled || !config.injectContext || !agent || !agent.inject) return;
      let recalled: string | null;
      try {
        recalled = await raceBudget(
          client.getContext({ peerId, assistantPeerId: config.assistantPeerId }),
          deps.recallBudgetMs ?? RECALL_BUDGET_MS,
        );
      } catch (error) {
        ctx.logger.warn(`honcho: recall failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!recalled) return;
      const text = sanitizeText(recalled, config.maxContextChars);
      if (!text) return;
      // Method call keeps the driver's `this` (inject splices the next-step inbox).
      agent.inject(
        userMessage(`<honcho-recall>\n${text}\n</honcho-recall>`, {
          kind: "honcho-recall",
          form: "recall",
          peer: peerId,
          workspace: workspaceId,
        }),
      );
    });
  });

  ctx.effect(() => async () => {
    try {
      await tracker.shutdown();
    } catch (error) {
      ctx.logger.warn(`honcho: tracker shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, "honcho outbox");

  function containAsync(what: string, step: () => Promise<unknown>): Promise<void> {
    return step().then(
      () => undefined,
      (error: unknown) => {
        ctx.logger.warn(`honcho: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined as void;
      },
    );
  }
}

/**
 * Native dsh cordis bundle: Honcho memory loop (recall → inject, capture →
 * outbox → upload, retry on next session). Mounts via the bundle's
 * `cordis.patch.yml` row (`name: dsh-plugin-honcho`).
 */
export default class HonchoPlugin extends Service {
  static inject = ["sessions"];
  // The vendored schemastery has no `.optional()`: object fields are optional
  // by default (a missing key resolves to undefined), `.default()` supplies
  // fallbacks — same resolved shape as the SPEC contract.
  static Config = z.object({
    baseUrl: z.string().default("https://api.honcho.dev"),
    workspaceId: z.string(),
    peerId: z.string().default("lei"),
    assistantPeerId: z.string().default("dsh"),
    enabled: z.boolean().default(true),
    injectContext: z.boolean().default(true),
    capturePrompts: z.boolean().default(true),
    captureResponses: z.boolean().default(true),
    maxContextChars: z.number().default(8_000),
    maxCaptureChars: z.number().default(12_000),
    debug: z.boolean().default(false),
  });

  constructor(ctx: Context, config: HonchoConfig) {
    super(ctx, "honcho");
    // SAFETY: the harness Context satisfies WireContext structurally — wireHoncho
    // only binds the handlers declared on WireContext and never uses Context
    // members beyond them, so the narrowing cannot hide a missing member.
    wireHoncho(ctx as unknown as WireContext, config);
  }
}
