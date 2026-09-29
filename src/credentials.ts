import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

export interface Credentials {
  apiKey: string;
  /** Optional overrides; null when absent (config wins per SPEC dual-channel). */
  baseUrl: string | null;
  workspaceId: string | null;
  peerId: string | null;
}

export interface CredentialsOptions {
  /** Environment mapping consulted for HONCHO_API_KEY. */
  env: Record<string, string | undefined>;
  /** Harness home override; defaults to resolveDshHome() (~/.dsh unless $DSH_HOME). */
  dshHome?: string;
}

function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? nonEmpty(value) : null;
}

/**
 * Honcho credential resolution: `HONCHO_API_KEY` from the environment overrides
 * the apiKey, while `baseUrl`/`workspaceId`/`peerId` keep coming from
 * `honcho.json` (`{apiKey, baseUrl?, workspaceId?, peerId?}` under the harness
 * home) — a partial env (key only) must not drop the file's workspace. Returns
 * null when no apiKey resolves anywhere; never throws.
 */
export function resolveCredentials(options: CredentialsOptions): Credentials | null {
  let fromFile: { apiKey?: string | undefined; baseUrl?: string | undefined; workspaceId?: string | undefined; peerId?: string | undefined } = {};
  try {
    const raw = readFileSync(join(options.dshHome ?? resolveDshHome(), "honcho.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      fromFile = {
        apiKey: optionalString(record.apiKey) ?? undefined,
        baseUrl: optionalString(record.baseUrl) ?? undefined,
        workspaceId: optionalString(record.workspaceId) ?? undefined,
        peerId: optionalString(record.peerId) ?? undefined,
      };
    }
  } catch {
    // Missing home, missing file, or corrupt JSON: env may still carry the key.
  }
  const apiKey = nonEmpty(options.env.HONCHO_API_KEY) ?? fromFile.apiKey ?? null;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: fromFile.baseUrl ?? null,
    workspaceId: fromFile.workspaceId ?? null,
    peerId: fromFile.peerId ?? null,
  };
}
