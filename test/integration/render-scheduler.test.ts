import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type TestApp } from "../helpers/app.ts";
import { MIN, T0 } from "../helpers/domain.ts";
import { CHANNEL, msg, startTracked, typing } from "../helpers/scenario.ts";

let app: TestApp;

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
  app = await createApp();
});
afterEach(async () => {
  await app.dispose();
  vi.useRealTimers();
});

const edits = () => app.discord.count("editCompanion");

describe("RenderScheduler", () => {
  it("coalesces 20 state changes within 2s into one edit", async () => {
    const targets = Array.from({ length: 20 }, (_, i) => String(10 + i));
    const { sourceId } = await startTracked(app, { targets });
    for (const [i, u] of targets.entries()) {
      await app.service.recordSignal(msg(u, { replyTo: sourceId, at: T0 + i * 100 }));
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(edits()).toBe(1);
  });

  it("max wait of 10s holds under continuous changes", async () => {
    const targets = Array.from({ length: 15 }, (_, i) => String(10 + i));
    const { sourceId } = await startTracked(app, { targets });
    for (const [i, u] of targets.entries()) {
      await app.service.recordSignal(msg(u, { replyTo: sourceId, at: T0 + i * 1000 }));
      await vi.advanceTimersByTimeAsync(1_000);
      if (i === 8) expect(edits()).toBe(0); // 9s since first change
      if (i === 9) expect(edits()).toBe(1); // max wait (10s) reached
    }
    await vi.advanceTimersByTimeAsync(20_000);
    expect(edits()).toBe(2);
  });

  it("repeat typing by the same user changes nothing → no edits", async () => {
    await startTracked(app, { targets: ["1"] });
    await app.service.recordSignal(typing("1", T0 + 1000));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(edits()).toBe(1);
    for (let i = 2; i < 30; i++) await app.service.recordSignal(typing("1", T0 + i * 1000));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(edits()).toBe(1);
  });

  it("an unchanged hash is not re-sent", async () => {
    const { tracked } = await startTracked(app);
    await app.scheduler.renderNow(tracked.id);
    expect(edits()).toBe(0);
  });

  it("10008 on edit → status_deleted", async () => {
    const { tracked, sourceId } = await startTracked(app);
    app.discord.editResults.push({ ok: false, kind: "MessageMissing", code: 10008 });
    await app.service.recordSignal(msg("1", { replyTo: sourceId }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await app.repo.getTracked(tracked.id))?.stopReason).toBe("status_deleted");
  });

  it("archived thread defers the render until THREAD_UNARCHIVED", async () => {
    const { tracked, sourceId } = await startTracked(app);
    app.discord.editResults.push({ ok: false, kind: "ArchivedThread", code: 50083 });
    await app.service.recordSignal(msg("1", { replyTo: sourceId }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(edits()).toBe(1);
    const before = (await app.repo.getTracked(tracked.id))?.renderedHash;
    await app.service.recordSignal({ t: "THREAD_UNARCHIVED", threadId: CHANNEL });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(edits()).toBe(2);
    expect((await app.repo.getTracked(tracked.id))?.renderedHash).not.toBe(before);
  });

  it("forbidden edits back off 30s → 2m → 10m then wait for the next change", async () => {
    const { sourceId } = await startTracked(app);
    for (let i = 0; i < 4; i++)
      app.discord.editResults.push({ ok: false, kind: "Forbidden", code: 50013 });
    await app.service.recordSignal(msg("1", { replyTo: sourceId }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(edits()).toBe(1);
    await vi.advanceTimersByTimeAsync(33_000);
    expect(edits()).toBe(2);
    await vi.advanceTimersByTimeAsync(123_000);
    expect(edits()).toBe(3);
    await vi.advanceTimersByTimeAsync(603_000);
    expect(edits()).toBe(4);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(edits()).toBe(4);
  });

  it("serializes edits: a change during an in-flight edit yields exactly one follow-up", async () => {
    const { tracked, sourceId } = await startTracked(app);
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = app.discord.editCompanion.bind(app.discord);
    let concurrent = 0;
    let maxConcurrent = 0;
    vi.spyOn(app.discord, "editCompanion").mockImplementation(async (...args) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (maxConcurrent === 1 && concurrent === 1 && edits() === 0) await gate;
      const r = await original(...args);
      concurrent -= 1;
      return r;
    });
    await app.service.recordSignal(msg("1", { replyTo: sourceId }));
    await vi.advanceTimersByTimeAsync(3_000); // edit #1 in flight (blocked)
    await app.service.recordSignal(msg("2", { replyTo: sourceId }));
    void app.scheduler.renderNow(tracked.id);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maxConcurrent).toBe(1);
    expect(app.discord.editCompanion).toHaveBeenCalledTimes(2);
  });
});
