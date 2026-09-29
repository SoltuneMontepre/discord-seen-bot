import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectView } from "../../src/app/view.ts";
import { timestampOf } from "../../src/domain/snowflake.ts";
import { type AutoApp, createAutoApp } from "../helpers/app.ts";
import { autoRows, message, policy, post, readyGuild, targetsOf } from "../helpers/auto.ts";
import { MIN, T0 } from "../helpers/domain.ts";
import { snowflakeAt } from "../helpers/fake-discord.ts";
import { AUTHOR, CHANNEL, GUILD, msg, typing } from "../helpers/scenario.ts";

let app: AutoApp;

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
  app = await createAutoApp({ features: { mentionAutoTrack: true, roleTargets: true } });
});
afterEach(async () => {
  await app.dispose();
  vi.useRealTimers();
});

const upsert = (userId: string, roleIds: string[], bot = false) =>
  app.coordinator.onMemberEvent({ t: "member_upsert", guildId: GUILD, userId, roleIds, bot });
const remove = (userId: string) =>
  app.coordinator.onMemberEvent({ t: "member_remove", guildId: GUILD, userId });
const roleDelete = (roleId: string) =>
  app.coordinator.onMemberEvent({ t: "role_delete", guildId: GUILD, roleId });

async function first() {
  const [t] = await autoRows(app);
  if (!t) throw new Error("no auto tracking");
  return t;
}

/** A policy tracking in #CHANNEL for role 700 with the given members. */
async function policyTracking(members: Record<string, string[]>, extra: { users?: string[] } = {}) {
  await policy(app, ["700"]);
  await readyGuild(app, members);
  await post(app, message(extra));
  return first();
}

describe("member events", () => {
  it("role gained → added with a fresh addedAt", async () => {
    const t = await policyTracking({ "1": ["700"] });
    vi.setSystemTime(T0 + 5 * MIN);
    await upsert("2", ["700"]);
    const added = (await app.repo.listTargets(t.id)).find((x) => x.userId === "2");
    expect(added).toEqual({ userId: "2", addedByUserId: "0", addedAt: T0 + 5 * MIN });
  });

  it("role lost → removed with evidence and ack", async () => {
    const t = await policyTracking({ "1": ["700"], "2": ["700"] });
    await app.repo.acknowledge(t.id, "2", T0 + MIN);
    await upsert("2", []);
    expect(await targetsOf(app, t.id)).toEqual(["1"]);
    expect(await app.repo.getAck(t.id, "2")).toBeUndefined();
  });

  it("switching between two qualifying roles keeps the same target row", async () => {
    await policy(app, ["701"]);
    const t = await policyTracking({ "1": ["700"], "2": ["700"] });
    const before = (await app.repo.listTargets(t.id)).find((x) => x.userId === "2");
    vi.setSystemTime(T0 + 5 * MIN);
    await upsert("2", ["701"]);
    const after = (await app.repo.listTargets(t.id)).find((x) => x.userId === "2");
    expect(after).toEqual(before);
  });

  it("multi-role member losing one qualifying role stays", async () => {
    await policy(app, ["701"]);
    const t = await policyTracking({ "1": ["700"], "2": ["700", "701"] });
    await upsert("2", ["701"]);
    expect(await targetsOf(app, t.id)).toEqual(["1", "2"]);
  });

  it("explicit user who loses the role stays", async () => {
    const t = await policyTracking({ "1": ["700"], "2": ["700"] }, { users: ["2"] });
    await upsert("2", []);
    expect(await targetsOf(app, t.id)).toEqual(["1", "2"]);
  });

  it("member leaves: role-derived removed, explicit stays (E6)", async () => {
    const t = await policyTracking({ "1": ["700"], "2": ["700"], "3": ["700"] }, { users: ["3"] });
    await remove("2");
    await remove("3");
    expect(await targetsOf(app, t.id)).toEqual(["1", "3"]);
  });

  it("rapid duplicate updates → idempotent, one change", async () => {
    const t = await policyTracking({ "1": ["700"] });
    await Promise.all([upsert("2", ["700"]), upsert("2", ["700"]), upsert("2", ["700"])]);
    const rows = (await app.repo.listTargets(t.id)).filter((x) => x.userId === "2");
    expect(rows).toHaveLength(1);
  });

  it("nickname-only update (same roles) → no DB writes", async () => {
    const t = await policyTracking({ "1": ["700"] });
    const spy = vi.spyOn(app.targetReconciler, "reconcileInQueue");
    const before = await app.repo.loadView(t.id);
    await upsert("1", ["700"]);
    await upsert("9", ["999"]);
    expect(spy).not.toHaveBeenCalled();
    expect(await app.repo.loadView(t.id)).toEqual(before);
  });

  it("manual trackings are untouched by member events", async () => {
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    const sourceId = snowflakeAt(T0, 7);
    app.discord.addMessage(CHANNEL, sourceId, AUTHOR);
    const m = await app.service.startTracking({
      guildId: GUILD,
      channelId: CHANNEL,
      parentChannelId: null,
      sourceMessageId: sourceId,
      sourceAuthorId: AUTHOR,
      sourceCreatedAt: timestampOf(sourceId),
      creatorUserId: AUTHOR,
      targets: ["1"],
    });
    if (m.kind !== "started") throw new Error();
    await upsert("1", []);
    await upsert("2", ["700"]);
    await remove("1");
    expect(await targetsOf(app, m.tracked.id)).toEqual(["1"]);
  });

  it("paused → member events are dropped, no writes", async () => {
    const t = await policyTracking({ "1": ["700"] });
    app.autoHealth?.set(GUILD, "failed");
    await upsert("2", ["700"]);
    await remove("1");
    expect(await targetsOf(app, t.id)).toEqual(["1"]);
    expect(app.index?.membersOf(GUILD, "700").map((m) => m.userId)).toEqual(["1"]);
  });

  it("weak evidence respects the dynamic addedAt", async () => {
    const t = await policyTracking({ "1": ["700"] });
    vi.setSystemTime(T0 + 2 * MIN);
    await app.service.recordSignal(typing("2", T0 + 2 * MIN));
    vi.setSystemTime(T0 + 3 * MIN);
    await upsert("2", ["700"]);
    expect((await app.repo.listEvidence(t.id)).filter((e) => e.userId === "2")).toEqual([]);
    vi.setSystemTime(T0 + 4 * MIN);
    await app.service.recordSignal(typing("2", T0 + 4 * MIN));
    const ev = (await app.repo.listEvidence(t.id)).filter((e) => e.userId === "2");
    expect(ev.map((e) => [e.kind, e.occurredAt])).toEqual([["TYPING_AFTER", T0 + 4 * MIN]]);
  });
});

describe("D2 full sequence (spec §6.4)", () => {
  it("re-added target: fresh addedAt, no ack, backfill restores reply + reaction → INTERACTED", async () => {
    // Keep "1" as a stable target so the tracking never reaches zero targets.
    const t = await policyTracking({ "1": ["700"], "3": ["700"] });
    const source = t.source_message_id;
    const oldAddedAt = (await app.repo.listTargets(t.id)).find((x) => x.userId === "3")?.addedAt;
    // 2. C confirms
    vi.setSystemTime(T0 + MIN);
    expect((await app.service.acknowledge(t.id, "3", T0 + MIN)).kind).toBe("acknowledged");
    // 3. C direct-replies (history holds the reply) and reacts
    vi.setSystemTime(T0 + 2 * MIN);
    const reply = msg("3", { at: T0 + 2 * MIN, replyTo: source });
    app.discord.addMessage(CHANNEL, reply.messageId, "3", [reply]);
    await app.service.recordSignal(reply);
    app.discord.addReaction(CHANNEL, source, "👍", 0, { id: "3" });
    // 4. C loses @role
    vi.setSystemTime(T0 + 3 * MIN);
    await upsert("3", []);
    // 5. target, ack and reply-evidence rows = 0
    expect((await app.repo.listTargets(t.id)).some((x) => x.userId === "3")).toBe(false);
    expect(await app.repo.getAck(t.id, "3")).toBeUndefined();
    expect((await app.repo.listEvidence(t.id)).filter((e) => e.userId === "3")).toEqual([]);
    // typing while not a target
    vi.setSystemTime(T0 + 4 * MIN);
    await app.service.recordSignal(typing("3", T0 + 4 * MIN));
    // 6. C regains @role
    vi.setSystemTime(T0 + 5 * MIN);
    await upsert("3", ["700"]);
    // 7. new target with a later added_at
    const re = (await app.repo.listTargets(t.id)).find((x) => x.userId === "3");
    expect(re?.addedAt).toBe(T0 + 5 * MIN);
    expect(re?.addedAt).toBeGreaterThan(oldAddedAt ?? Number.POSITIVE_INFINITY);
    // 8. no ack row
    expect(await app.repo.getAck(t.id, "3")).toBeUndefined();
    // 10–11. backfill rediscovers the reply; the reaction pass rediscovers the reaction
    await app.backfillQueue.idle();
    const ev = (await app.repo.listEvidence(t.id)).filter((e) => e.userId === "3");
    expect(ev.map((e) => e.kind).sort()).toEqual(["DIRECT_REACTION", "DIRECT_REPLY"]);
    // 9. no weak evidence dated before the new added_at
    expect(ev.some((e) => e.kind === "TYPING_AFTER" || e.kind === "CHANNEL_MESSAGE_AFTER")).toBe(
      false,
    );
    // 12. INTERACTED "replied", not CONFIRMED
    const view = await app.repo.loadView(t.id);
    if (!view) throw new Error();
    const row = projectView(view).find((r) => r.userId === "3");
    expect(row?.state).toBe("INTERACTED");
    expect(row?.basis?.kind).toBe("DIRECT_REPLY");
  });
});

describe("role delete", () => {
  it("live delete prunes the policy role and tracking_sources role rows", async () => {
    await policy(app, ["700", "701"]);
    await readyGuild(app, { "1": ["700"], "2": ["701"], "3": ["702"] });
    await post(app, message({ roles: ["702"] }));
    const t = await first();
    expect(await app.repo.listTrackingSources(t.id)).toEqual([{ type: "role", roleId: "702" }]);
    await roleDelete("702");
    await roleDelete("700");
    expect(await app.repo.listTrackingSources(t.id)).toEqual([]);
    expect(
      (await app.policies.listForChannel(CHANNEL, { offset: 0, limit: 10 }))[0]?.roleIds,
    ).toEqual(["701"]);
    expect(await targetsOf(app, t.id)).toEqual(["2"]);
  });

  it("users qualified elsewhere stay; others are removed", async () => {
    await policy(app, ["701"]);
    const t = await policyTracking({ "1": ["700", "701"], "2": ["700"] });
    await roleDelete("700");
    expect(await targetsOf(app, t.id)).toEqual(["1"]);
  });

  it("zero → no_eligible_targets", async () => {
    await readyGuild(app, { "1": ["701"] });
    await post(app, message({ roles: ["701"] }));
    const t = await first();
    await roleDelete("701");
    const after = await app.repo.getTracked(t.id);
    expect(after?.stopReason).toBe("no_eligible_targets");
    expect(await targetsOf(app, t.id)).toEqual([]);
  });

  it("enabled policy losing its last role → auto_disabled_missing_role (state_changed_by '0')", async () => {
    const p = await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"] });
    await roleDelete("700");
    expect(await app.policies.get(p.id)).toMatchObject({
      state: "auto_disabled_missing_role",
      stateChangedBy: "0",
    });
  });

  it("user_disabled policy losing its last role → stays user_disabled", async () => {
    const p = await policy(app, ["700"]);
    await app.policies.setState(p.id, "user_disabled", "9", T0);
    await readyGuild(app, {});
    await roleDelete("700");
    expect((await app.policies.get(p.id))?.state).toBe("user_disabled");
  });

  it("paused → pruning committed, reconcile deferred until healthy", async () => {
    await policy(app, ["701"]);
    const t = await policyTracking({ "1": ["700", "701"], "2": ["700"] });
    app.autoHealth?.set(GUILD, "failed");
    await roleDelete("700");
    expect(
      (await app.policies.listForChannel(CHANNEL, { offset: 0, limit: 10 })).map((p) => p.roleIds),
    ).toEqual([["701"], []]);
    expect(await targetsOf(app, t.id)).toEqual(["1", "2"]); // deferred
    app.discord.guildRoles.set(GUILD, [GUILD, "701"]);
    app.discord.setMember(GUILD, "2", []);
    app.rebuilder?.requestRebuild(GUILD, "retry");
    await app.settle(GUILD);
    expect(app.autoHealth?.state(GUILD)).toBe("healthy");
    expect(await targetsOf(app, t.id)).toEqual(["1"]);
  });

  it("duplicate delete event → no-op", async () => {
    const t = await policyTracking({ "1": ["700"] });
    await policy(app, ["701"], "601");
    await roleDelete("701");
    const before = await app.repo.loadView(t.id);
    await roleDelete("701");
    expect(await app.repo.loadView(t.id)).toEqual(before);
  });
});

describe("guild events", () => {
  it("guild_available schedules a rebuild; guild_unavailable pauses; onReady resets", async () => {
    await policy(app, ["700"]);
    app.discord.guildRoles.set(GUILD, [GUILD, "700"]);
    await app.coordinator.onMemberEvent({ t: "guild_available", guildId: GUILD });
    await app.settle(GUILD);
    expect(app.autoHealth?.state(GUILD)).toBe("healthy");
    await app.coordinator.onMemberEvent({ t: "guild_unavailable", guildId: GUILD });
    expect(app.autoHealth?.state(GUILD)).toBe("unavailable");
    app.coordinator.onReady();
    expect(app.autoHealth?.state(GUILD)).toBe("awaiting_guild");
  });

  it("guild_removed clears index and health for that guild", async () => {
    await policyTracking({ "1": ["700"] });
    await app.coordinator.onMemberEvent({ t: "guild_removed", guildId: GUILD });
    expect(app.index?.membersOf(GUILD, "700")).toEqual([]);
    expect(app.autoHealth?.state(GUILD)).toBe("awaiting_guild");
  });
});

describe("referenced-role prune", () => {
  it("a role removed from its last enabled policy leaves the index on the next prune tick", async () => {
    const p = await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"], "2": ["700", "701"] });
    await policy(app, ["701"], "601");
    await app.queue.run(
      GUILD,
      () =>
        app.rebuilder?.rebuildNowInQueue(GUILD, "roles_grew", {
          extraReferencedRoleIds: ["701"],
          reconcile: false,
        }) ?? Promise.resolve("healthy" as const),
    );
    await app.policies.setState(p.id, "user_disabled", "9", T0);
    app.coordinator.requestReferencedRolePrune(GUILD);
    await app.settle(GUILD);
    expect(app.index?.membersOf(GUILD, "700")).toEqual([]);
    expect(app.index?.membersOf(GUILD, "701").map((m) => m.userId)).toEqual(["2"]);
    expect(app.index?.memberCount(GUILD)).toBe(1);
  });

  it("the only message-role source stopping → role dropped on the next prune", async () => {
    await readyGuild(app, { "1": ["701"] });
    await post(app, message({ roles: ["701"] }));
    const t = await first();
    expect(app.index?.referencedRoles(GUILD).has("701")).toBe(true);
    await app.repo.stopAuto(t.id, "feature_disabled", T0);
    app.coordinator.requestReferencedRolePrune(GUILD);
    await app.settle(GUILD);
    expect(app.index?.referencedRoles(GUILD).has("701")).toBe(false);
    expect(app.index?.memberCount(GUILD)).toBe(0);
  });

  it("prune keeps still-referenced roles and never adds a newly referenced role", async () => {
    await policy(app, ["700"]);
    await readyGuild(app, { "1": ["700"], "2": ["701"] });
    await policy(app, ["701"], "601"); // referenced in the DB, not indexed yet
    app.coordinator.requestReferencedRolePrune(GUILD);
    await app.settle(GUILD);
    expect([...(app.index?.referencedRoles(GUILD) ?? [])]).toEqual(["700"]);
    expect(app.index?.membersOf(GUILD, "701")).toEqual([]);
  });

  it("prune runs via runKeyed (no nested queue call)", async () => {
    const spy = vi.spyOn(app.queue, "runKeyed");
    app.coordinator.requestReferencedRolePrune(GUILD);
    await app.settle(GUILD);
    expect(spy).toHaveBeenCalledWith(GUILD, "prune-referenced-roles", expect.any(Function));
  });

  it("a role deletion prunes inline", async () => {
    await policy(app, ["700", "701"]);
    await readyGuild(app, { "1": ["700"], "2": ["701"] });
    await roleDelete("701");
    expect([...(app.index?.referencedRoles(GUILD) ?? [])]).toEqual(["700"]);
    expect(app.index?.memberCount(GUILD)).toBe(1);
  });
});
