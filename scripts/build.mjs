// Build artifact gate: after `tsc -p tsconfig.build.json`, verify the bundle
// layout dsh's plugin manager expects is present:
//   lib/index.js      — CJS entry ("main", exports["."].default)
//   lib/index.d.ts    — type entry
//   cordis.patch.yml  — bundle patch at the package root (shipped as-is)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const entry = join(root, "lib", "index.js");
if (!existsSync(entry)) {
  problems.push("missing lib/index.js");
} else {
  const head = readFileSync(entry, "utf8").slice(0, 4096);
  // dsh loads bundle entries through createRequire; ESM output would break it.
  if (/^\s*(import|export)\b/m.test(head.replace(/\/\/[^\n]*/g, ""))) {
    problems.push("lib/index.js does not look like CommonJS");
  }
}

if (!existsSync(join(root, "lib", "index.d.ts"))) {
  problems.push("missing lib/index.d.ts");
}

const patch = join(root, "cordis.patch.yml");
if (!existsSync(patch)) {
  problems.push("missing cordis.patch.yml at package root");
} else if (!/name:\s*dsh-plugin-honcho/.test(readFileSync(patch, "utf8"))) {
  problems.push("cordis.patch.yml does not declare the dsh-plugin-honcho row");
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (pkg.main !== "lib/index.js") problems.push("package.json main must be lib/index.js");
if (!pkg.dsh?.bundle?.patch) problems.push("package.json must declare dsh.bundle.patch (installer refuses bundles without it)");

if (problems.length) {
  console.error(`build artifact check failed:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log("build artifacts ok: lib/index.js (CJS), lib/index.d.ts, cordis.patch.yml");

// Pack regression: pnpm pack honors .gitignore when no "files" field exists,
// which silently drops lib/ from the published tarball (index.js survives only
// because main is force-included). Assert every built module ships.
const { execFileSync } = await import("node:child_process");
const packListing = execFileSync("pnpm", ["pack", "--dry-run"], { cwd: root, encoding: "utf8" });
const required = [
  "lib/index.js",
  "lib/plugin.js",
  "lib/memory-tracker.js",
  "lib/outbox.js",
  "lib/honcho-client.js",
  "lib/credentials.js",
  "cordis.patch.yml",
];
const missing = required.filter((file) => !packListing.includes(file));
if (missing.length) {
  console.error(`pack check failed — missing from tarball:\n  - ${missing.join("\n  - ")}\nAdd a "files" whitelist to package.json (it overrides .gitignore).`);
  process.exit(1);
}
console.log("pack check ok: lib modules + cordis.patch.yml ship in the tarball");
