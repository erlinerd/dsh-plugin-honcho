#!/usr/bin/env node
// Local development setup: the @deepseek-ai/dsh-session and
// @deepseek-ai/dsh-home-paths type packages are not published to npm yet, so
// local typecheck/build needs symlinks into a local DeepSeek Harness install.
// Safe to re-run; does nothing when no harness install is found (lint/test
// still work — only typecheck/build need these).
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WANTED = ["dsh-session", "dsh-home-paths"];

function candidateInstalls() {
  const fromEnv = process.env.DSH_DEV_INSTALL?.trim();
  const candidates = [];
  if (fromEnv) candidates.push(fromEnv);
  const miseBase = join(homedir(), ".local/share/mise/installs/node");
  try {
    for (const version of readdirSync(miseBase)) {
      candidates.push(join(miseBase, version, "lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"));
    }
  } catch {
    // No mise install — fine.
  }
  const fnmBase = join(homedir(), ".local/share/fnm/node-versions");
  try {
    for (const version of readdirSync(fnmBase)) {
      candidates.push(join(fnmBase, version, "installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"));
    }
  } catch {
    // No fnm install — fine.
  }
  return candidates;
}

let linked = 0;
for (const base of candidateInstalls()) {
  if (WANTED.every((name) => existsSync(join(base, name)))) {
    const targetDir = join(process.cwd(), "node_modules", "@deepseek-ai");
    mkdirSync(targetDir, { recursive: true });
    for (const name of WANTED) {
      const linkPath = join(targetDir, name);
      if (!existsSync(linkPath)) symlinkSync(join(base, name), linkPath, "dir");
    }
    console.log(`dev-setup: linked ${WANTED.join(", ")} from ${base}`);
    linked = WANTED.length;
    break;
  }
}
if (!linked) {
  console.log(
    "dev-setup: no local DeepSeek Harness install found — skipping. " +
      "lint/test work without it; set DSH_DEV_INSTALL to point at one for typecheck/build.",
  );
}
