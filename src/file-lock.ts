import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_WAIT_MS = 25;
const LOCK_ATTEMPTS = 160;
const STALE_LOCK_MS = 60_000;

export interface FileLockOptions {
  attempts?: number;
  waitMs?: number;
  staleMs?: number;
}

type NodeError = { code?: unknown };

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as NodeError).code;
  return typeof code === "string" ? code : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeStaleLock(lockPath: string, staleMs: number): Promise<void> {
  try {
    const details = await stat(lockPath);
    if (Date.now() - details.mtimeMs > staleMs)
      await rm(lockPath, { force: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/**
 * Cross-process mutual exclusion over a lock file (O_EXCL create), ported
 * from zcode-plugin-honcho. Wait/staleness budgets are injectable for tests;
 production defaults tolerate a stale holder after 60s and give up after
 ~4s of contention.
 */
export async function withFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? LOCK_ATTEMPTS;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? STALE_LOCK_MS;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  let acquired = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      acquired = true;
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      await removeStaleLock(lockPath, staleMs);
      await wait(waitMs);
    }
  }

  if (!acquired) throw new Error("Timed out acquiring the plugin state lock");

  try {
    return await task();
  } finally {
    await rm(lockPath, { force: true });
  }
}
