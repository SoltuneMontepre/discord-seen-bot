import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AutoApp, createAutoApp } from "../helpers/app.ts";
import { autoRows, message, policy, post, readyGuild, targetsOf, until } from "../helpers/auto.ts";
import { MIN, T0 } from "../helpers/domain.ts";
import { snowflakeAt } from "../helpers/fake-discord.ts";
import { AUTHOR, CHANNEL, GUILD } from "../helpers/scenario.ts";

let app: AutoApp;

async function make(
  features = { mentionAutoTrack: false, roleTargets: true },
  policyOverrides = {},
) {
  app = await createAutoApp({ features, policy: policyOverrides });
  return app;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await app?.dispose();
  vi.useRealTimers();
});

describe("policy-triggered auto tracking", () => {
  it("plain message in a policy channel → one auto card for the role's members minus author/bots", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(
      app,
      { "1": ["700"], "2": ["700"], [AUTHOR]: ["700"], "950": ["700"], "3": ["701"] },
      { bots: ["950"] },
    );
    await post(app, message());
    const rows = await autoRows(app);
    expect(rows).toHaveLength(1);
    const t = rows[0];
    if (!t) throw new Error();
    expect(t).toMatchObject({
      origin: "auto",
      creator_user_id: AUTHOR,
      channel_type: 0,
      source_author_id: AUTHOR,
    });
    expect(t.status_message_id).not.toBeNull();
    expect(await targetsOf(app, t.id)).toEqual(["1", "2"]);
    expect(await app.repo.listTrackingSources(t.id)).toEqual([]); // policy roles are live, not stored
    expect(app.discord.count("createCompanion")).toBe(1);
    const created = (await app.repo.listTargets(t.id))[0];
    expect(created?.addedAt).toBe(T0);
  });

  it("two policies in the channel → one card with the union of targets", async () => {
    await make();
    await policy(app, ["700"], CHANNEL, "dev");
    await policy(app, ["701"], CHANNEL, "qa");
    await readyGuild(app, { "1": ["700"], "2": ["701"], "3": ["700", "701"] });
    await post(app, message());
    const rows = await autoRows(app);
    expect(rows).toHaveLength(1);
    expect(await targetsOf(app, rows[0]?.id ?? 0)).toEqual(["1", "2", "3"]);
  });

  it("a message in a channel without a policy creates nothing", async () => {
    await make();
    await policy(app, ["700"], "601");
    await readyGuild(app, { "1": ["700"] });
    await post(app, message());
    expect(await autoRows(app)).toEqual([]);
  });

  it("replayed MESSAGE_CREATE → one row, one createCompanion call", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    const m = message();
    await post(app, m);
    await post(app, m);
    expect(await autoRows(app)).toHaveLength(1);
    expect(app.discord.count("createCompanion")).toBe(1);
  });

  it("after the auto tracking stopped, a replay creates nothing (permanent uniqueness)", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    const m = message();
    await post(app, m);
    const [t] = await autoRows(app);
    await app.repo.stopAuto(t?.id ?? 0, "feature_disabled", T0 + MIN);
    await post(app, m);
    expect(await autoRows(app)).toHaveLength(1);
    expect(app.discord.count("createCompanion")).toBe(1);
  });

  it("zero eligible → no row, no createCompanion", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { [AUTHOR]: ["700"], "950": ["700"] }, { bots: ["950"] });
    await post(app, message());
    expect(await autoRows(app)).toEqual([]);
    expect(app.discord.count("createCompanion")).toBe(0);
  });

  it("over the limit → no row + one warn per channel per 10 min", async () => {
    await make(undefined, { autoTrackMaxTargets: 2 });
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"], "2": ["700"], "3": ["700"] });
    const warns = () =>
      app.logger.entries.filter((e) => e.msg === "auto-track skipped: too many eligible members");
    await post(app, message());
    expect(await autoRows(app)).toEqual([]);
    expect(warns()).toHaveLength(1);
    expect(warns()[0]?.obj).toMatchObject({
      guildId: GUILD,
      channelId: CHANNEL,
      resolved: 3,
      limit: 2,
    });
    vi.setSystemTime(T0 + 9 * MIN);
    await post(app, message());
    expect(warns()).toHaveLength(1);
    vi.setSystemTime(T0 + 11 * MIN);
    await post(app, message());
    expect(warns()).toHaveLength(2);
  });

  it("paused guild + policy channel → no creation", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    app.autoHealth?.set(GUILD, "failed");
    await post(app, message());
    expect(await autoRows(app)).toEqual([]);
  });

  it("publish failure rolls back the row and its sources; a warn is logged", async () => {
    await make({ mentionAutoTrack: true, roleTargets: true });
    await readyGuild(app, {});
    app.discord.createResults.push({
      ok: false,
      error: { kind: "MissingPermissions", permissions: ["SEND_MESSAGES"] },
    });
    await post(app, message({ users: ["1"] }));
    expect(await autoRows(app)).toEqual([]);
    const sources = await app.db.selectFrom("tracking_sources").selectAll().execute();
    expect(sources).toEqual([]);
    expect(
      app.logger.entries.some((e) => e.msg === "auto-track companion could not be posted"),
    ).toBe(true);
  });

  it("a member change during a pending publish is reflected after publish", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    let open!: () => void;
    app.discord.createGate = new Promise<void>((r) => {
      open = r;
    });
    const done = post(app, message());
    await until(() => app.discord.count("createCompanion") === 1);
    const [t] = await autoRows(app);
    const id = t?.id ?? 0;
    await app.queue.run(GUILD, async () => {
      app.index?.upsert(GUILD, "2", ["700"], false);
      await app.targetReconciler.reconcileInQueue(id);
    });
    open();
    await done;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await targetsOf(app, id)).toEqual(["1", "2"]);
    expect(app.discord.count("editCompanion")).toBe(1);
  });

  it("a reconcile-stop during a pending publish renders the frozen card after publish", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    let open!: () => void;
    app.discord.createGate = new Promise<void>((r) => {
      open = r;
    });
    const done = post(app, message());
    await until(() => app.discord.count("createCompanion") === 1);
    const [t] = await autoRows(app);
    const id = t?.id ?? 0;
    await app.queue.run(GUILD, async () => {
      app.index?.upsert(GUILD, "1", [], false);
      expect(await app.targetReconciler.reconcileInQueue(id)).toBe("stopped");
    });
    open();
    await done;
    await vi.advanceTimersByTimeAsync(10_000);
    const after = await app.repo.getTracked(id);
    expect(after?.stopReason).toBe("no_eligible_targets");
    expect(after?.statusMessageId).not.toBeNull();
    expect(app.discord.count("editCompanion")).toBe(1);
  });

  it("phase B is not run inside the guild queue", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    let open!: () => void;
    app.discord.createGate = new Promise<void>((r) => {
      open = r;
    });
    const done = post(app, message());
    await until(() => app.discord.count("createCompanion") === 1);
    await expect(app.settle(GUILD)).resolves.toBeUndefined(); // queue is free while publishing
    open();
    await done;
  });

  it("initial backfill runs after publish", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    await post(app, message());
    const [t] = await autoRows(app);
    expect(t?.initial_backfill_at).not.toBeNull();
  });

  it("gap-scan (history) messages never create auto tracking (D3)", async () => {
    await make({ mentionAutoTrack: true, roleTargets: true });
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    const id = snowflakeAt(T0 + MIN, 1);
    app.discord.addMessage(CHANNEL, id, AUTHOR, [
      {
        t: "MESSAGE",
        guildId: GUILD,
        channelId: CHANNEL,
        messageId: id,
        authorId: AUTHOR,
        occurredAt: T0 + MIN,
      },
    ]);
    await app.repo.setWatermark(T0);
    vi.setSystemTime(T0 + 30 * MIN);
    const { readyAt } = app.health.onReady();
    await app.reconciler.onFreshSession(readyAt);
    expect(await autoRows(app)).toEqual([]);
  });
});
