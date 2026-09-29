import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { DEFAULT_POLICY } from "../../src/domain/policy.ts";

const base = { DISCORD_TOKEN: "t", DISCORD_APPLICATION_ID: "123456789012345678" };

describe("loadConfig", () => {
  it("uses product policy defaults", () => {
    const c = loadConfig({ ...base });
    expect(c.policy).toEqual(DEFAULT_POLICY);
    expect(c.databasePath).toBe("./data/seen.db");
  });

  it("applies dev overrides outside production", () => {
    const c = loadConfig({ ...base, SEEN_WEAK_WINDOW_MINUTES: "2", SEEN_RETENTION_MINUTES: "5" });
    expect(c.policy.weakWindowMs).toBe(120_000);
    expect(c.policy.retentionMs).toBe(300_000);
  });

  it("ignores dev overrides and debug payloads in production", () => {
    const c = loadConfig({
      ...base,
      NODE_ENV: "production",
      SEEN_WEAK_WINDOW_MINUTES: "2",
      SEEN_DEBUG_PAYLOADS: "1",
    });
    expect(c.policy.weakWindowMs).toBe(DEFAULT_POLICY.weakWindowMs);
    expect(c.debugPayloads).toBe(false);
  });

  it("rejects missing token", () => {
    expect(() => loadConfig({ DISCORD_APPLICATION_ID: base.DISCORD_APPLICATION_ID })).toThrow(
      /DISCORD_TOKEN/,
    );
  });
});
