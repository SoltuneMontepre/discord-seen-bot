import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeCustomId } from "../../src/discord/custom-id.ts";
import { MSG } from "../../src/discord/render/text.ts";
import { type AutoApp, createAutoApp } from "../helpers/app.ts";
import { autoRows, message, policy, post, readyGuild, targetsOf } from "../helpers/auto.ts";
import { MIN, T0 } from "../helpers/domain.ts";
import { componentInteraction, type FakeResponder, makeRouter } from "../helpers/interactions.ts";
import { AUTHOR, CHANNEL, GUILD, nextId } from "../helpers/scenario.ts";
import { tempDbPath } from "../helpers/tmp.ts";

const BOTH = { mentionAutoTrack: true, roleTargets: true };
let apps: AutoApp[] = [];
let app: AutoApp;
let router: ReturnType<typeof makeRouter>["router"];
let responder: FakeResponder;

async function make(features = BOTH, dbPath?: string) {
  app = await createAutoApp({ features, ...(dbPath ? { dbPath } : {}) });
  apps.push(app);
  ({ router, responder } = makeRouter(app));
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

type Row = Awaited<ReturnType<typeof autoRows>>[number];

async function counts() {
  const n = async (table: string) =>
    Number(
      (await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(app.db))
        .rows[0]?.n,
    );
  return {
    acks: await n("acknowledgements"),
    evidence: await n("evidence"),
    targets: await n("tracking_targets"),
  };
}

async function click(
  t: { id: number; status_message_id: string | null },
  userId: string,
  messageId?: string,
) {
  await router.handle(
    componentInteraction(encodeCustomId({ action: "ack", trackedId: t.id }), {
      userId,
      messageId: messageId ?? t.status_message_id ?? "0",
    }),
  );
}

/** A rejected click: ephemeral notice, zero writes, and no card edit even after debounce. */
async function expectRejected(t: Row, userId: string) {
  await vi.advanceTimersByTimeAsync(15_000); // settle renders caused by earlier changes
  const before = await counts();
  const edits = app.discord.count("editCompanion");
  await click(t, userId);
  expect(responder.last()?.kind).toBe("replyEphemeral");
  expect(responder.text()).toBe(MSG.notTarget);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await counts()).toEqual(before);
  expect(app.discord.count("editCompanion")).toBe(edits);
}

async function expectConfirmed(t: Row, userId: string) {
  await click(t, userId);
  expect(responder.last()?.kind).toBe("update");
  expect((await app.repo.getAck(t.id, userId))?.revokedAt).toBeNull();
}

async function only() {
  const rows = await autoRows(app);
  const t = rows.at(-1);
  if (!t) throw new Error();
  return t;
}

describe("acknowledgement authorization (R12)", () => {
  it("A1: a current auto target confirms; count +1", async () => {
    await make();
    await readyGuild(app, {});
    await post(app, message({ users: ["1", "2"] }));
    const t = await only();
    await expectConfirmed(t, "1");
    expect(JSON.stringify(responder.last()?.data)).toContain("1/2 confirmed");
  });

  it("A2/A3/A7: the source author and a non-target are rejected with zero writes and no render", async () => {
    await make();
    await readyGuild(app, {});
    await post(app, message({ users: ["1"] }));
    const t = await only();
    await expectRejected(t, AUTHOR);
    await expectRejected(t, "5");
  });

  it("A4: a dynamically removed target is rejected; target and evidence are not restored", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"], "2": ["700"] });
    await post(app, message());
    const t = await only();
    await expectConfirmed(t, "2");
    await app.coordinator.onMemberEvent({
      t: "member_upsert",
      guildId: GUILD,
      userId: "2",
      roleIds: [],
      bot: false,
    });
    await expectRejected(t, "2");
    expect(await targetsOf(app, t.id)).toEqual(["1"]);
    expect(await app.repo.getAck(t.id, "2")).toBeUndefined();
  });

  it("A5: a dynamically added target confirms via the existing card's custom_id", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    await post(app, message());
    const t = await only();
    await app.coordinator.onMemberEvent({
      t: "member_upsert",
      guildId: GUILD,
      userId: "3",
      roleIds: ["700"],
      bot: false,
    });
    await expectConfirmed(t, "3");
    expect(app.discord.count("createCompanion")).toBe(1);
  });

  it("A6: explicit user who lost the role still confirms", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"], "2": ["700"] });
    await post(app, message({ users: ["2"] }));
    const t = await only();
    await app.coordinator.onMemberEvent({
      t: "member_upsert",
      guildId: GUILD,
      userId: "2",
      roleIds: [],
      bot: false,
    });
    await expectConfirmed(t, "2");
  });

  it("A8: stale card (target row deleted after the last render) → rejected; wrong message id → outdated", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"], "2": ["700"] });
    await post(app, message());
    const t = await only();
    app.discord.editResults.push({ ok: false, kind: "Transient" }); // card still shows "2"
    await app.coordinator.onMemberEvent({
      t: "member_upsert",
      guildId: GUILD,
      userId: "2",
      roleIds: [],
      bot: false,
    });
    await expectRejected(t, "2");
    await click(t, "1", "123");
    expect(responder.text()).toBe(MSG.outdated);
  });

  it("A9: a new app instance on the same DB gives the same outcomes", async () => {
    const tmp = tempDbPath("a9");
    await make(BOTH, tmp.path);
    await readyGuild(app, {});
    await post(app, message({ users: ["1"] }));
    const t = await only();
    await make(BOTH, tmp.path);
    await expectRejected(t, "5");
    await expectConfirmed(t, "1");
    for (const a of apps) await a.dispose();
    apps = [];
    tmp.cleanup();
  });

  it("A10: manual target confirms, manual non-target rejected; role changes never alter manual targets", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    const sourceId = nextId(T0 - MIN);
    app.discord.addMessage(CHANNEL, sourceId, AUTHOR);
    const r = await app.service.startTracking({
      guildId: GUILD,
      channelId: CHANNEL,
      parentChannelId: null,
      sourceMessageId: sourceId,
      sourceAuthorId: AUTHOR,
      sourceCreatedAt: T0 - MIN,
      creatorUserId: AUTHOR,
      targets: ["1"],
    });
    if (r.kind !== "started") throw new Error();
    const m = { id: r.tracked.id, status_message_id: r.statusMessageId } as Row;
    await app.coordinator.onMemberEvent({
      t: "member_upsert",
      guildId: GUILD,
      userId: "1",
      roleIds: [],
      bot: false,
    });
    await app.coordinator.onMemberEvent({
      t: "member_upsert",
      guildId: GUILD,
      userId: "3",
      roleIds: ["700"],
      bot: false,
    });
    await expectRejected(m, "3");
    await expectConfirmed(m, "1");
  });

  it("A11: acknowledge racing a removal never leaves an ack for a non-target (both orders)", async () => {
    await make();
    await readyGuild(app, {});
    await post(app, message({ users: ["1", "2"] }));
    const t = await only();
    // ack then removal
    await app.repo.acknowledge(t.id, "2", T0 + MIN);
    await app.repo.reconcileAutoTargets(t.id, ["1"], T0 + 2 * MIN);
    expect(await app.repo.getAck(t.id, "2")).toBeUndefined();
    // removal then ack
    await app.repo.reconcileAutoTargets(t.id, ["1", "3"], T0 + 3 * MIN);
    const [a, b] = await Promise.all([
      app.repo.reconcileAutoTargets(t.id, ["1"], T0 + 4 * MIN),
      app.repo.acknowledge(t.id, "3", T0 + 4 * MIN),
    ]);
    expect(a.status).toBe("changed");
    expect(b.result === "not_target" || b.result === "acknowledged").toBe(true);
    const acks = await app.repo.listAcks(t.id);
    const targets = new Set(await targetsOf(app, t.id));
    expect(acks.every((x) => targets.has(x.userId))).toBe(true);
  });

  it("A12: while paused a persisted target confirms; recovery removing them deletes the ack", async () => {
    await make();
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"], "2": ["700"] });
    await post(app, message());
    const t = await only();
    app.autoHealth?.set(GUILD, "failed");
    await expectConfirmed(t, "2");
    app.discord.setMember(GUILD, "2", []);
    app.rebuilder?.requestRebuild(GUILD, "retry");
    await app.settle(GUILD);
    expect(await app.repo.getAck(t.id, "2")).toBeUndefined();
    await expectRejected(t, "2");
  });

  it("A13: composite — only persisted targets confirm", async () => {
    // roles off: @Dev members never targeted
    await make({ mentionAutoTrack: true, roleTargets: false });
    await post(app, message({ users: ["1"], roles: ["700"] }));
    const rolesOff = await only();
    await expectRejected(rolesOff, "7"); // a @Dev member
    await expectConfirmed(rolesOff, "1");

    await make(BOTH);
    await policy(app, ["700"], CHANNEL);
    await readyGuild(app, { "4": ["700"] });
    // forward: snapshot user rejected, outer forwarder mention accepted
    await post(app, {
      ...message({ users: ["21"], channelId: "601" }),
      flags: 1 << 14,
      message_snapshots: [{ message: { mentions: [{ id: "23" }], mention_roles: [] } }],
    });
    const fwd = await only();
    await expectRejected(fwd, "23");
    await expectConfirmed(fwd, "21");
    // thread: parent-policy member rejected, thread target accepted
    await post(app, message({ users: ["5"], channelId: "650", channelType: 11 }));
    const thread = await only();
    await expectRejected(thread, "4");
    await expectConfirmed(thread, "5");
    // explicit user who left stays a target
    await post(app, message({ users: ["6"], channelId: "602" }));
    const left = await only();
    await app.coordinator.onMemberEvent({ t: "member_remove", guildId: GUILD, userId: "6" });
    expect(await targetsOf(app, left.id)).toEqual(["6"]);
    await expectConfirmed(left, "6");
  });
});

describe("auto Manage", () => {
  it("auto Manage shows only Stop; sb1:targets on an auto tracking is refused", async () => {
    await make();
    await readyGuild(app, {});
    await post(app, message({ users: ["1"] }));
    const t = await only();
    await router.handle(
      componentInteraction(encodeCustomId({ action: "manage", trackedId: t.id }), {
        userId: AUTHOR,
        messageId: t.status_message_id ?? "0",
      }),
    );
    const panel = JSON.stringify(responder.last()?.data);
    expect(responder.text()).toBe(MSG.manageAutoTitle);
    expect(panel).toContain(encodeCustomId({ action: "stop", trackedId: t.id }));
    expect(panel).not.toContain(encodeCustomId({ action: "targets", trackedId: t.id }));

    const before = await targetsOf(app, t.id);
    await router.handle(
      componentInteraction(encodeCustomId({ action: "targets", trackedId: t.id }), {
        userId: AUTHOR,
        values: ["9"],
        resolvedUsers: { "9": {} },
      }),
    );
    expect(responder.text()).toBe(MSG.autoTargetsFixed);
    expect(await targetsOf(app, t.id)).toEqual(before);

    await router.handle(
      componentInteraction(encodeCustomId({ action: "stop", trackedId: t.id }), { userId: AUTHOR }),
    );
    expect((await app.repo.getTracked(t.id))?.stopReason).toBe("manual");
  });
});
