import { describe, expect, it } from "vitest";
import { redactSensitiveText, sanitizeText, truncate } from "../src/domain/bounds.js";

describe("truncate", () => {
  it("keeps short values intact", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  it("bounds long values with an explicit marker", () => {
    const out = truncate("a".repeat(300), 100);
    expect(out.length).toBe(100);
    expect(out.endsWith("… [truncated]")).toBe(true);
    expect(out.startsWith("aaaa")).toBe(true);
  });

  it("returns the marker alone for tiny budgets", () => {
    expect(truncate("abcdef", 3)).toBe("… […".slice(0, 3));
    expect(truncate("abcdef", 0)).toBe("");
  });
});

describe("redactSensitiveText", () => {
  it("redacts bearer tokens", () => {
    expect(redactSensitiveText("auth: Bearer abc123def")).toBe("auth: [REDACTED]");
  });

  it("redacts api-key assignments", () => {
    const out = redactSensitiveText("api_key = supersecretvalue123");
    expect(out).not.toContain("supersecretvalue123");
    expect(out).toContain("[REDACTED]");
  });
});

describe("sanitizeText", () => {
  it("passes null through", () => {
    expect(sanitizeText(null, 100)).toBeNull();
  });

  it("redacts before truncating so secrets survive no window", () => {
    const secret = "Bearer aaaaBBBBccccdddd";
    const out = sanitizeText(`token=${secret} and padding ${"x".repeat(500)}`, 50);
    expect(out).not.toContain("aaaaBBBB");
    expect(out).toContain("[REDACTED]");
    expect(out!.length).toBe(50);
  });
});
