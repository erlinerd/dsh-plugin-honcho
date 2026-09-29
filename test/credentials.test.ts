import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCredentials } from "../src/credentials.js";

function makeHome(files: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-honcho-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      join(home, name),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return home;
}

describe("resolveCredentials", () => {
  it("env key overrides only the key; file keeps workspace and peer", () => {
    const home = makeHome({ "honcho.json": { apiKey: "file-key", baseUrl: "https://file", workspaceId: "ws-1", peerId: "lei" } });
    try {
      expect(resolveCredentials({ env: { HONCHO_API_KEY: "env-key" }, dshHome: home })).toEqual({
        apiKey: "env-key",
        baseUrl: "https://file",
        workspaceId: "ws-1",
        peerId: "lei",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("env-only key (no file) yields no workspace", () => {
    const home = makeHome({});
    try {
      expect(resolveCredentials({ env: { HONCHO_API_KEY: "env-key" }, dshHome: home })).toEqual({
        apiKey: "env-key",
        baseUrl: null,
        workspaceId: null,
        peerId: null,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to honcho.json with optional overrides", () => {
    const home = makeHome({
      "honcho.json": {
        apiKey: "file-key",
        baseUrl: "https://honcho.local",
        workspaceId: "ws-1",
        peerId: "lei",
      },
    });
    try {
      expect(resolveCredentials({ env: {}, dshHome: home })).toEqual({
        apiKey: "file-key",
        baseUrl: "https://honcho.local",
        workspaceId: "ws-1",
        peerId: "lei",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns null silently when neither source has a key", () => {
    const home = makeHome({});
    try {
      expect(resolveCredentials({ env: {}, dshHome: home })).toBeNull();
      expect(resolveCredentials({ env: {}, dshHome: join(home, "missing") })).toBeNull();
      expect(resolveCredentials({ env: { HONCHO_API_KEY: "   " }, dshHome: home })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats a corrupt or non-object honcho.json as missing", () => {
    const home = makeHome({ "honcho.json": "{ not json" });
    try {
      expect(resolveCredentials({ env: {}, dshHome: home })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
