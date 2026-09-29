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

describe("loadConfig — M9 feature flags and limit", () => {
  it("defaults: both flags false, autoTrackMaxTargets 100", () => {
    const c = loadConfig({ ...base });
    expect(c.features).toEqual({ mentionAutoTrack: false, roleTargets: false });
    expect(c.policy.autoTrackMaxTargets).toBe(100);
  });

  it("parses MENTION_AUTO_TRACK_ENABLED=true and ROLE_TARGETS_ENABLED=true independently", () => {
    expect(loadConfig({ ...base, MENTION_AUTO_TRACK_ENABLED: "true" }).features).toEqual({
      mentionAutoTrack: true,
      roleTargets: false,
    });
    expect(loadConfig({ ...base, ROLE_TARGETS_ENABLED: "true" }).features).toEqual({
      mentionAutoTrack: false,
      roleTargets: true,
    });
    expect(
      loadConfig({ ...base, MENTION_AUTO_TRACK_ENABLED: "true", ROLE_TARGETS_ENABLED: "true" })
        .features,
    ).toEqual({ mentionAutoTrack: true, roleTargets: true });
  });

  it('rejects flag value "yes"', () => {
    expect(() => loadConfig({ ...base, ROLE_TARGETS_ENABLED: "yes" })).toThrow(
      /ROLE_TARGETS_ENABLED/,
    );
    expect(() => loadConfig({ ...base, MENTION_AUTO_TRACK_ENABLED: "1" })).toThrow(
      /MENTION_AUTO_TRACK_ENABLED/,
    );
  });

  it("AUTO_TRACK_MAX_TARGETS=1 and =500 accepted (boundaries), also in production", () => {
    expect(loadConfig({ ...base, AUTO_TRACK_MAX_TARGETS: "1" }).policy.autoTrackMaxTargets).toBe(1);
    expect(
      loadConfig({ ...base, NODE_ENV: "production", AUTO_TRACK_MAX_TARGETS: "500" }).policy
        .autoTrackMaxTargets,
    ).toBe(500);
  });

  it.each(["0", "501", "abc", "12.5", "-3"])(
    "rejects AUTO_TRACK_MAX_TARGETS=%s with an error naming the variable",
    (v) => {
      expect(() => loadConfig({ ...base, AUTO_TRACK_MAX_TARGETS: v })).toThrow(
        /AUTO_TRACK_MAX_TARGETS/,
      );
    },
  );

  it("existing dev overrides unaffected by the new variables", () => {
    const c = loadConfig({ ...base, SEEN_WEAK_WINDOW_MINUTES: "2", ROLE_TARGETS_ENABLED: "true" });
    expect(c.policy.weakWindowMs).toBe(120_000);
    expect(c.policy.pauseNoticeGraceMs).toBe(60_000);
    expect(c.policy.renderEditConcurrency).toBe(2);
  });
});
