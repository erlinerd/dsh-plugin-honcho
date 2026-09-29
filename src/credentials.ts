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
 * Honcho credential resolution, highest precedence first:
 *   1. `HONCHO_API_KEY` from the environment (no override channels there).
 *   2. `honcho.json` (`{apiKey, baseUrl?, workspaceId?, peerId?}`) under the harness home.
 * Returns null when neither source yields an apiKey — the plugin then
 * silently disables itself; this function never throws.
 */
export function resolveCredentials(options: CredentialsOptions): Credentials | null {
  const fromEnv = nonEmpty(options.env.HONCHO_API_KEY);
  if (fromEnv) {
    return { apiKey: fromEnv, baseUrl: null, workspaceId: null, peerId: null };
  }

  try {
    const raw = readFileSync(join(options.dshHome ?? resolveDshHome(), "honcho.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const apiKey = optionalString(record.apiKey);
      if (apiKey) {
        return {
          apiKey,
          baseUrl: optionalString(record.baseUrl),
          workspaceId: optionalString(record.workspaceId),
          peerId: optionalString(record.peerId),
        };
      }
    }
  } catch {
    // Missing home, missing file, or corrupt JSON: the plugin stays disabled.
  }
  return null;
}
