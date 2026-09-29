import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageToAutoTrackCandidate } from "../../src/discord/adapters/message.ts";
import { buildIntents } from "../../src/discord/intents.ts";
import { type AutoApp, createAutoApp } from "../helpers/app.ts";
import { autoRows, message, policy, post, readyGuild, targetsOf } from "../helpers/auto.ts";
import { T0 } from "../helpers/domain.ts";
import { AUTHOR, CHANNEL, GUILD } from "../helpers/scenario.ts";
import { tempDbPath } from "../helpers/tmp.ts";

const M_ON_R_ON = { mentionAutoTrack: true, roleTargets: true };
const M_ON_R_OFF = { mentionAutoTrack: true, roleTargets: false };
const M_OFF_R_ON = { mentionAutoTrack: false, roleTargets: true };

let apps: AutoApp[] = [];
async function make(features: { mentionAutoTrack: boolean; roleTargets: boolean }, extra = {}) {
  const app = await createAutoApp({ features, ...extra });
  apps.push(app);
  return app;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  for (const a of apps) await a.dispose();
  apps = [];
  vi.useRealTimers();
});

async function only(app: AutoApp) {
  const rows = await autoRows(app);
  expect(rows).toHaveLength(1);
  const t = rows[0];
  if (!t) throw new Error();
  return t;
}

describe("mention-triggered auto tracking", () => {
  it("M1: @user in an unconfigured channel → tracking + user source row", async () => {
    const app = await make(M_ON_R_ON);
    await readyGuild(app, {});
    await post(app, message({ users: ["1"] }));
    const t = await only(app);
    expect(await targetsOf(app, t.id)).toEqual(["1"]);
    expect(await app.repo.listTrackingSources(t.id)).toEqual([{ type: "user", userId: "1" }]);
  });

  it("M2: @role (both flags) → role members + role source row (index extended in-queue)", async () => {
    const app = await make(M_ON_R_ON);
    await readyGuild(app, { "1": ["701"], "2": ["701"], "3": ["702"] });
    expect(app.discord.count("listGuildMembers")).toBe(0); // nothing referenced yet
    const resumed = () => app.logger.entries.filter((e) => e.msg === "auto-track resumed").length;
    const before = resumed();
    await post(app, message({ roles: ["701"] }));
    const t = await only(app);
    expect(await targetsOf(app, t.id)).toEqual(["1", "2"]);
    expect(await app.repo.listTrackingSources(t.id)).toEqual([{ type: "role", roleId: "701" }]);
    expect(app.discord.count("listGuildMembers")).toBe(1);
    expect(app.autoHealth?.state(GUILD)).toBe("healthy");
    expect(resumed()).toBe(before); // an index extension is not a resume
  });

  it("M2b: index extension failure → fail closed, nothing created", async () => {
    const app = await make(M_ON_R_ON);
    await readyGuild(app, { "1": ["701"] });
    app.discord.memberFailures.push({
      ok: false,
      class: "Transient",
      code: 500,
      error: new Error(),
    });
    await post(app, message({ users: ["2"], roles: ["701"] }));
    expect(await autoRows(app)).toEqual([]);
  });

  it("M3/M4: @everyone / @here → no tracking", async () => {
    const app = await make(M_ON_R_ON);
    await readyGuild(app, { "1": ["700"] });
    await post(app, message({ everyone: true }));
    expect(await autoRows(app)).toEqual([]);
  });

  it("M5: <@&guildId> is ignored", async () => {
    const app = await make(M_ON_R_ON);
    await readyGuild(app, { "1": [GUILD] });
    await post(app, message({ roles: [GUILD] }));
    expect(await autoRows(app)).toEqual([]);
  });

  it("M7: author self-mention excluded", async () => {
    const app = await make(M_ON_R_ON);
    await readyGuild(app, {});
    await post(app, message({ users: [AUTHOR] }));
    expect(await autoRows(app)).toEqual([]);
    await post(app, message({ users: [AUTHOR, "1"] }));
    const t = await only(app);
    expect(await targetsOf(app, t.id)).toEqual(["1"]);
  });

  it("M8: duplicates collapse across explicit users and roles", async () => {
    const app = await make(M_ON_R_ON);
    await readyGuild(app, { "1": ["701"], "2": ["701", "702"] });
    await post(app, message({ users: ["1", "1"], roles: ["701", "702"] }));
    const t = await only(app);
    expect(await targetsOf(app, t.id)).toEqual(["1", "2"]);
  });

  it("M9: mention + policy → exactly one card, union", async () => {
    const app = await make(M_ON_R_ON);
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    await post(app, message({ users: ["2"] }));
    const t = await only(app);
    expect(await targetsOf(app, t.id)).toEqual(["1", "2"]);
    expect(app.discord.count("createCompanion")).toBe(1);
  });

  it("M11: replay → sources inserted once", async () => {
    const app = await make(M_ON_R_ON);
    await readyGuild(app, {});
    const m = message({ users: ["1", "2"] });
    await post(app, m);
    await post(app, m);
    const sources = await app.db.selectFrom("tracking_sources").selectAll().execute();
    expect(sources).toHaveLength(2);
    expect(await autoRows(app)).toHaveLength(1);
  });

  it("M12: the limit applies after the full union (101 → none, 100 → created)", async () => {
    const app = await make(M_ON_R_ON);
    const members = Object.fromEntries(
      Array.from({ length: 99 }, (_, i) => [String(1000 + i), ["701"]]),
    );
    await readyGuild(app, members);
    await post(app, message({ users: ["1000", "2000", "2001"], roles: ["701"] })); // 99 + 2 = 101
    expect(await autoRows(app)).toEqual([]);
    await post(app, message({ users: ["1000", "2000"], roles: ["701"] })); // 99 + 1 = 100
    const t = await only(app);
    expect(await targetsOf(app, t.id)).toHaveLength(100);
  });

  it("M13: only bots / author / an empty role → none", async () => {
    const app = await make(M_ON_R_ON);
    await readyGuild(app, { "950": ["701"], [AUTHOR]: ["701"] }, { bots: ["950"] });
    await post(app, message({ users: ["951", AUTHOR], roles: ["701", "702"] }));
    expect(await autoRows(app)).toEqual([]);
  });

  it("M14a: M on R off, @user → tracking, no role rows; intents 3585", async () => {
    const app = await make(M_ON_R_OFF);
    await post(app, message({ users: ["1"] }));
    const t = await only(app);
    expect(await app.repo.listTrackingSources(t.id)).toEqual([{ type: "user", userId: "1" }]);
    expect(buildIntents(M_ON_R_OFF)).toBe(3585);
    expect(app.discord.count("listGuildMembers")).toBe(0);
  });

  it("M14b: M on R off, @role only → none", async () => {
    const app = await make(M_ON_R_OFF);
    await post(app, message({ roles: ["701"] }));
    expect(await autoRows(app)).toEqual([]);
  });

  it("M14c: M on R off, @user + @role → user only; turning ROLE on later adds nothing (frozen)", async () => {
    const tmp = tempDbPath("m14c");
    const dbPath = tmp.path;
    const off = await make(M_ON_R_OFF, { dbPath });
    await post(off, message({ users: ["1"], roles: ["701"] }));
    const t = await only(off);
    expect(await off.repo.listTrackingSources(t.id)).toEqual([{ type: "user", userId: "1" }]);
    await off.dispose();
    apps = apps.filter((a) => a !== off);

    const on = await make(M_ON_R_ON, { dbPath });
    await readyGuild(on, { "2": ["701"] });
    await on.queue.run(GUILD, () => on.targetReconciler.reconcileGuildInQueue(GUILD));
    expect(await targetsOf(on, t.id)).toEqual(["1"]);
    expect(await on.repo.listTrackingSources(t.id)).toEqual([{ type: "user", userId: "1" }]);
    await on.dispose();
    apps = apps.filter((a) => a !== on);
    tmp.cleanup();
  });

  it("M14d: M off R on → policies only; mentions are not collected", async () => {
    const app = await make(M_OFF_R_ON);
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"], "3": ["701"] });
    await post(app, message({ users: ["2"], roles: ["701"] }));
    const t = await only(app);
    expect(await targetsOf(app, t.id)).toEqual(["1"]);
    expect(await app.repo.listTrackingSources(t.id)).toEqual([]);
    await post(app, message({ users: ["2"], channelId: "601" }));
    expect(await autoRows(app)).toHaveLength(1);
  });

  it("M15a: paused + explicit-only → created", async () => {
    const app = await make(M_ON_R_ON);
    app.autoHealth?.set(GUILD, "failed");
    await post(app, message({ users: ["1"], channelId: "601" }));
    const t = await only(app);
    expect(await targetsOf(app, t.id)).toEqual(["1"]);
    const body = JSON.stringify(app.discord.companions.get(t.status_message_id ?? "")?.body);
    expect(body).toContain("Auto-tracked");
    expect(body).not.toContain("Auto-track temporarily paused");
  });

  it("M15b: paused + explicit + mentioned role → none; paused + explicit in a policy channel → none", async () => {
    const app = await make(M_ON_R_ON);
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"], "2": ["701"] });
    app.autoHealth?.set(GUILD, "failed");
    await post(app, message({ users: ["3"], roles: ["701"], channelId: "601" }));
    await post(app, message({ users: ["3"] }));
    expect(await autoRows(app)).toEqual([]);
    expect(app.discord.count("listGuildMembers")).toBe(1); // no index extension while paused
  });

  it("M19: thread and forum-post mentions → message sources only; unsupported types → none", async () => {
    const app = await make(M_ON_R_ON);
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"], "2": ["701"] });
    await post(app, message({ users: ["3"], channelId: "650", channelType: 11 }));
    await post(app, message({ roles: ["701"], channelId: "651", channelType: 12 }));
    await post(app, message({ users: ["3"], channelId: "652", channelType: undefined }));
    await post(app, message({ users: ["3"], channelId: "653", channelType: 2 }));
    const rows = await autoRows(app);
    expect(rows.map((r) => [r.channel_id, r.channel_type])).toEqual([
      ["650", 11],
      ["651", 12],
    ]);
    expect(await targetsOf(app, rows[0]?.id ?? 0)).toEqual(["3"]);
    expect(await targetsOf(app, rows[1]?.id ?? 0)).toEqual(["2"]);
  });

  it("M20: a parent policy never applies to, or reconciles, a thread tracking", async () => {
    const app = await make(M_ON_R_ON);
    await policy(app, ["700"], CHANNEL);
    await readyGuild(app, { "1": ["700"] });
    await post(app, message({ users: ["3"], channelId: "650", channelType: 11 }));
    const t = await only(app);
    app.index?.upsert(GUILD, "4", ["700"], false);
    await app.queue.run(GUILD, () => app.targetReconciler.reconcileChannelInQueue(GUILD, CHANNEL));
    await app.queue.run(GUILD, () => app.targetReconciler.reconcileGuildInQueue(GUILD));
    expect(await targetsOf(app, t.id)).toEqual(["3"]);
  });

  it("M21/M22: forward — snapshot ignored, outer kept, overlap dropped", async () => {
    const app = await make(M_ON_R_ON);
    await readyGuild(app, {});
    const fwd = {
      ...message({ users: ["21", "22"] }),
      flags: 1 << 14,
      message_reference: { type: 1, message_id: "1", channel_id: "601" },
      message_snapshots: [
        { message: { mentions: [{ id: "22" }, { id: "23" }], mention_roles: [] } },
      ],
    };
    expect(messageToAutoTrackCandidate(fwd, app.features)?.explicitUserIds).toEqual(["21"]);
    await post(app, fwd);
    const t = await only(app);
    expect(await targetsOf(app, t.id)).toEqual(["21"]);
    const snapshotOnly = {
      ...message({ users: [] }),
      flags: 1 << 14,
      message_snapshots: [{ message: { mentions: [{ id: "23" }], mention_roles: [] } }],
    };
    await post(app, snapshotOnly);
    expect(await autoRows(app)).toHaveLength(1);
  });
});
