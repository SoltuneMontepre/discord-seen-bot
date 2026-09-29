import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuildAutoTrackHealth } from "../../src/app/guild-auto-track-health.ts";
import { memoryLogger } from "../helpers/app.ts";

let due: string[];
let health: GuildAutoTrackHealth;

beforeEach(() => {
  vi.useFakeTimers();
  due = [];
  health = new GuildAutoTrackHealth({
    clock: { now: () => Date.now() },
    policy: { pauseNoticeGraceMs: 60_000 },
    onPauseNoticeDue: (g) => due.push(g),
    logger: memoryLogger(),
  });
});
afterEach(() => {
  health.dispose();
  vi.useRealTimers();
});

describe("GuildAutoTrackHealth", () => {
  it("unknown guild is awaiting_guild (paused)", () => {
    expect(health.state("1")).toBe("awaiting_guild");
    expect(health.isPaused("1")).toBe(true);
  });

  it("set(healthy) → not paused; every other state is paused", () => {
    health.set("1", "healthy");
    expect(health.isPaused("1")).toBe(false);
    for (const s of [
      "rebuilding",
      "reconciling",
      "failed",
      "unavailable",
      "awaiting_guild",
    ] as const) {
      health.set("1", s);
      expect(health.isPaused("1")).toBe(true);
    }
  });

  it("entering a pause fires onPauseNoticeDue after exactly the grace", () => {
    health.set("1", "healthy");
    health.set("1", "unavailable");
    vi.advanceTimersByTime(59_999);
    expect(due).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(due).toEqual(["1"]);
    vi.advanceTimersByTime(600_000);
    expect(due).toEqual(["1"]); // once per pause
  });

  it("a flap back to healthy before the grace cancels the notice", () => {
    health.set("1", "healthy");
    health.set("1", "rebuilding");
    vi.advanceTimersByTime(30_000);
    health.set("1", "healthy");
    vi.advanceTimersByTime(60_000);
    expect(due).toEqual([]);
  });

  it("paused → paused transitions keep the original grace and pausedSince", () => {
    health.set("1", "rebuilding");
    const since = health.pausedSince("1");
    vi.advanceTimersByTime(40_000);
    health.set("1", "failed", { attempt: 1, nextRetryInMs: 60_000 });
    expect(health.pausedSince("1")).toBe(since);
    vi.advanceTimersByTime(20_000);
    expect(due).toEqual(["1"]);
    expect(health.detail("1")).toEqual({ attempt: 1, nextRetryInMs: 60_000 });
  });

  it("the first pause of an unknown guild also starts the grace", () => {
    health.set("1", "rebuilding");
    vi.advanceTimersByTime(60_000);
    expect(due).toEqual(["1"]);
  });

  it("resetAll → every known guild awaiting_guild", () => {
    health.set("1", "healthy");
    health.set("2", "failed");
    health.resetAll();
    expect(health.state("1")).toBe("awaiting_guild");
    expect(health.state("2")).toBe("awaiting_guild");
  });

  it("forget drops state and its timer", () => {
    health.set("1", "healthy");
    health.set("1", "unavailable");
    health.forget("1");
    vi.advanceTimersByTime(60_000);
    expect(due).toEqual([]);
    expect(health.state("1")).toBe("awaiting_guild");
  });
});
