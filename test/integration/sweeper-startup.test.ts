import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteUnfinishedStarts } from "../../src/app/startup-recovery.ts";
import { createApp, type TestApp } from "../helpers/app.ts";
import { newTracking } from "../helpers/db.ts";
import { DAY, MIN, T0 } from "../helpers/domain.ts";
import { AUTHOR, CHANNEL, GUILD, startTracked } from "../helpers/scenario.ts";
import { tempDbPath } from "../helpers/tmp.ts";

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

describe("Sweeper", () => {
  it("expires after 7 days (frozen card) and purges 30 days after stop", async () => {
    const { tracked, statusMessageId } = await startTracked(app);
    vi.setSystemTime(T0 + 7 * DAY - 1);
    expect(await app.sweeper.runOnce()).toEqual({ expired: 0, purged: 0 });
    vi.setSystemTime(T0 + 7 * DAY + 5 * MIN);
    expect(await app.sweeper.runOnce()).toEqual({ expired: 1, purged: 0 });
    const t = await app.repo.getTracked(tracked.id);
    expect(t).toMatchObject({ stopReason: "expired", stoppedAt: T0 + 7 * DAY });
    const body = JSON.stringify(app.discord.companions.get(statusMessageId)?.body);
    expect(body).toContain("Tracking ended · expired");
    expect(body).not.toContain("sb1:ack");

    vi.setSystemTime(T0 + 37 * DAY - 1);
    expect((await app.sweeper.runOnce()).purged).toBe(0);
    vi.setSystemTime(T0 + 37 * DAY);
    expect((await app.sweeper.runOnce()).purged).toBe(1);
    expect(await app.repo.getTracked(tracked.id)).toBeUndefined();
  });

  it("purges manually stopped rows 30 days after the stop", async () => {
    const { tracked } = await startTracked(app);
    await app.service.stop(tracked.id, "manual", AUTHOR, T0 + DAY);
    vi.setSystemTime(T0 + 31 * DAY);
    expect((await app.sweeper.runOnce()).purged).toBe(1);
  });
});

describe("startup recovery", () => {
  it("crash between insert and companion post: unfinished row deleted on boot; re-track works", async () => {
    const { path, cleanup } = tempDbPath("unfinished-start");
    try {
      const a = await createApp({ dbPath: path });
      app.discord.addMessage(CHANNEL, "4242", AUTHOR);
      const ins = await a.repo.insertTracking(
        newTracking({ sourceMessageId: "4242", guildId: GUILD }),
        ["1"],
      );
      expect(ins.ok).toBe(true);
      await a.dispose(); // "crash" before createCompanion

      const b = await createApp({ dbPath: path, discord: app.discord });
      expect(await deleteUnfinishedStarts(b.repo, b.logger)).toBe(1);
      expect(b.logger.entries.some((e) => e.level === "warn")).toBe(true);
      const r = await b.service.startTracking({
        guildId: GUILD,
        channelId: CHANNEL,
        parentChannelId: null,
        sourceMessageId: "4242",
        sourceAuthorId: AUTHOR,
        sourceCreatedAt: T0 - MIN,
        creatorUserId: AUTHOR,
        targets: ["1"],
      });
      expect(r.kind).toBe("started");
      await b.dispose();
    } finally {
      cleanup();
    }
  });
});
