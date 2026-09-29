import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NestedGuildQueueError } from "../../src/app/guild-queue.ts";
import type { PolicyService } from "../../src/app/policy-service.ts";
import { type AutoApp, createAutoApp } from "../helpers/app.ts";
import { autoRows, message, post, readyGuild, targetsOf } from "../helpers/auto.ts";
import { T0 } from "../helpers/domain.ts";
import { CHANNEL, GUILD } from "../helpers/scenario.ts";

let app: AutoApp;
let svc: PolicyService;
const actor = { userId: "9", guildId: GUILD, memberPermissions: "0" };

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
  app = await createAutoApp({
    features: { mentionAutoTrack: true, roleTargets: true },
    policy: { autoTrackMaxTargets: 5 },
  });
  if (!app.policyService) throw new Error();
  svc = app.policyService;
});
afterEach(async () => {
  await app.dispose();
  vi.useRealTimers();
});

async function created(roleId = "700", channelId = CHANNEL, name = "Dev") {
  const r = await svc.create(actor, { channelId, name, roleId });
  if (!r.ok) throw new Error(`create failed: ${r.error}`);
  return r.value;
}

describe("PolicyService", () => {
  it("create → enabled policy with the role; reconciles the channel's active auto trackings", async () => {
    await readyGuild(app, { "1": ["700"] });
    await post(app, message({ users: ["2"] })); // explicit-only tracking in the channel
    const [t] = await autoRows(app);
    const p = await created();
    expect(p).toMatchObject({
      guildId: GUILD,
      channelId: CHANNEL,
      name: "Dev",
      state: "enabled",
      roleIds: ["700"],
    });
    expect(await targetsOf(app, t?.id ?? 0)).toEqual(["1", "2"]);
  });

  it("multiple policies per channel act as a union; rename changes only the name", async () => {
    await readyGuild(app, { "1": ["700"], "2": ["701"] });
    const a = await created("700");
    await created("701", CHANNEL, "QA");
    await post(app, message());
    const [t] = await autoRows(app);
    expect(await targetsOf(app, t?.id ?? 0)).toEqual(["1", "2"]);
    const r = await svc.rename(actor, a.id, "Developers");
    expect(r.ok && r.value.name).toBe("Developers");
  });

  it("disable → user_disabled; enable with roles → enabled; keep_disabled only from auto_disabled", async () => {
    await readyGuild(app, {});
    const p = await created();
    const off = await svc.setState(actor, p.id, "disable");
    expect(off.ok && off.value.state).toBe("user_disabled");
    expect(await svc.setState(actor, p.id, "keep_disabled")).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
    const on = await svc.setState(actor, p.id, "enable");
    expect(on.ok && on.value.state).toBe("enabled");
  });

  it("enable with zero roles → needs_role; keep_disabled from auto_disabled → user_disabled", async () => {
    await readyGuild(app, {});
    const p = await created();
    await app.coordinator.onMemberEvent({ t: "role_delete", guildId: GUILD, roleId: "700" });
    expect((await app.policies.get(p.id))?.state).toBe("auto_disabled_missing_role");
    expect(await svc.setState(actor, p.id, "enable")).toMatchObject({
      ok: false,
      error: "needs_role",
    });
    const kept = await svc.setState(actor, p.id, "keep_disabled");
    expect(kept.ok && kept.value.state).toBe("user_disabled");
  });

  it("saveRoles on auto_disabled → enabled; on user_disabled → stays user_disabled; zero roles → needs_role", async () => {
    await readyGuild(app, { "1": ["701"] });
    const p = await created();
    await app.coordinator.onMemberEvent({ t: "role_delete", guildId: GUILD, roleId: "700" });
    const re = await svc.saveRoles(actor, p.id, ["701"]);
    expect(re.ok && re.value).toMatchObject({ state: "enabled", roleIds: ["701"] });
    await svc.setState(actor, p.id, "disable");
    const still = await svc.saveRoles(actor, p.id, ["701", "702"]);
    expect(still.ok && still.value).toMatchObject({
      state: "user_disabled",
      roleIds: ["701", "702"],
    });
    expect(await svc.saveRoles(actor, p.id, [])).toMatchObject({ ok: false, error: "needs_role" });
  });

  it("@everyone (roleId === guildId) → everyone_role", async () => {
    await readyGuild(app, {});
    expect(
      await svc.create(actor, { channelId: CHANNEL, name: "all", roleId: GUILD }),
    ).toMatchObject({
      ok: false,
      error: "everyone_role",
    });
    const p = await created();
    expect(await svc.saveRoles(actor, p.id, ["700", GUILD])).toMatchObject({
      ok: false,
      error: "everyone_role",
    });
  });

  it("invalid names are rejected", async () => {
    await readyGuild(app, {});
    expect(
      await svc.create(actor, { channelId: CHANNEL, name: "  ", roleId: "700" }),
    ).toMatchObject({
      ok: false,
      error: "invalid_name",
    });
    expect(
      await svc.create(actor, { channelId: CHANNEL, name: "x".repeat(101), roleId: "700" }),
    ).toMatchObject({
      ok: false,
      error: "invalid_name",
    });
  });

  it("30 policies in one channel can be created (no count limit)", async () => {
    await readyGuild(app, {});
    for (let i = 0; i < 30; i++) await created(String(800 + i), CHANNEL, `p${i}`);
    expect(await app.policies.countForChannel(CHANNEL)).toBe(30);
  });

  it("over the limit → over_limit with resolved/limit, nothing committed", async () => {
    await readyGuild(app, {
      "1": ["700"],
      "2": ["700"],
      "3": ["700"],
      "4": ["701"],
      "5": ["701"],
      "6": ["701"],
    });
    await created("700");
    const r = await svc.create(actor, { channelId: CHANNEL, name: "QA", roleId: "701" });
    expect(r).toEqual({ ok: false, error: "over_limit", detail: { resolved: 6, limit: 5 } });
    expect(await app.policies.countForChannel(CHANNEL)).toBe(1);
    const status = await svc.channelStatus(GUILD, CHANNEL);
    expect(status).toEqual({ paused: false, resolved: 3, limit: 5, overLimit: false });
  });

  it("an add-role that needs an index extension completes (no nested queue call)", async () => {
    await readyGuild(app, { "1": ["700"], "2": ["701"] });
    const p = await created("700");
    const calls = app.discord.count("listGuildMembers");
    const r = await svc.saveRoles(actor, p.id, ["700", "701"]);
    expect(r.ok).toBe(true);
    expect(app.discord.count("listGuildMembers")).toBe(calls + 1);
    expect(app.index?.membersOf(GUILD, "701").map((m) => m.userId)).toEqual(["2"]);
    expect(
      app.logger.entries.some(
        (e) => (e.obj as { err?: unknown }).err instanceof NestedGuildQueueError,
      ),
    ).toBe(false);
  });

  it("a member event arriving during that rebuild runs afterwards", async () => {
    await readyGuild(app, { "1": ["700"], "2": ["701"] });
    const p = await created("700");
    await post(app, message());
    const [t] = await autoRows(app);
    const order: string[] = [];
    const listSpy = vi.spyOn(app.discord, "listGuildMembers");
    listSpy.mockImplementation(async function (this: typeof app.discord, ...args) {
      order.push("rebuild");
      listSpy.mockRestore();
      return app.discord.listGuildMembers(...args);
    });
    const save = vi.spyOn(app.policies, "saveRolesAndState");
    save.mockImplementation(async (...args) => {
      order.push("commit");
      save.mockRestore();
      return app.policies.saveRolesAndState(...args);
    });
    let open!: () => void;
    app.discord.memberGate = new Promise<void>((r) => {
      open = r;
    });
    const saving = svc.saveRoles(actor, p.id, ["700", "701"]);
    await vi.advanceTimersByTimeAsync(0);
    const event = app.coordinator
      .onMemberEvent({
        t: "member_upsert",
        guildId: GUILD,
        userId: "3",
        roleIds: ["701"],
        bot: false,
      })
      .then(() => order.push("member-upsert"));
    open();
    app.discord.memberGate = null;
    await Promise.all([saving, event]);
    expect(order).toEqual(["rebuild", "commit", "member-upsert"]);
    expect(await targetsOf(app, t?.id ?? 0)).toEqual(["1", "2", "3"]);
  });

  it("paused: increasing changes → paused, nothing committed; decreasing changes commit, reconcile at recovery", async () => {
    await readyGuild(app, { "1": ["700"], "2": ["701"] });
    const a = await created("700");
    const b = await created("701", CHANNEL, "QA");
    await post(app, message());
    const [t] = await autoRows(app);
    expect(await targetsOf(app, t?.id ?? 0)).toEqual(["1", "2"]);
    app.autoHealth?.set(GUILD, "failed");
    expect(await svc.create(actor, { channelId: CHANNEL, name: "S", roleId: "702" })).toMatchObject(
      {
        ok: false,
        error: "paused",
      },
    );
    expect(await svc.saveRoles(actor, a.id, ["700", "702"])).toMatchObject({
      ok: false,
      error: "paused",
    });
    const off = await svc.setState(actor, b.id, "disable"); // decreasing: committed
    expect(off.ok && off.value.state).toBe("user_disabled");
    expect(await svc.setState(actor, b.id, "enable")).toMatchObject({ ok: false, error: "paused" });
    expect(await app.policies.countForChannel(CHANNEL)).toBe(2);
    expect((await app.policies.get(a.id))?.roleIds).toEqual(["700"]);
    // still role-dependent (a's @700 remains) → reconcile deferred while paused
    expect(await targetsOf(app, t?.id ?? 0)).toEqual(["1", "2"]);
    app.rebuilder?.requestRebuild(GUILD, "retry");
    await app.settle(GUILD);
    expect(await targetsOf(app, t?.id ?? 0)).toEqual(["1"]);
  });

  it("paused: deleting the last policy leaves no sources → D7 applies without member state", async () => {
    await readyGuild(app, { "1": ["700"] });
    const a = await created("700");
    await post(app, message());
    const [t] = await autoRows(app);
    app.autoHealth?.set(GUILD, "failed");
    expect((await svc.delete(actor, a.id)).ok).toBe(true);
    expect((await app.repo.getTracked(t?.id ?? 0))?.stopReason).toBe("no_eligible_targets");
  });

  it("a policy id from another guild → not_found for every mutation", async () => {
    await readyGuild(app, {});
    const p = await created();
    const other = { ...actor, guildId: "501" };
    expect(await svc.rename(other, p.id, "x")).toMatchObject({ ok: false, error: "not_found" });
    expect(await svc.saveRoles(other, p.id, ["700"])).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await svc.setState(other, p.id, "disable")).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await svc.delete(other, p.id)).toMatchObject({ ok: false, error: "not_found" });
    expect(await svc.delete(actor, 999)).toMatchObject({ ok: false, error: "not_found" });
    expect((await app.policies.get(p.id))?.name).toBe("Dev");
  });

  it("delete reconciles only that channel's active auto trackings", async () => {
    await readyGuild(app, { "1": ["700"], "2": ["700"] });
    const a = await created("700", CHANNEL);
    await created("700", "601", "Other");
    await post(app, message({ users: ["3"] }));
    await post(app, message({ users: ["3"], channelId: "601" }));
    const [here, there] = await autoRows(app);
    await svc.delete(actor, a.id);
    expect(await targetsOf(app, here?.id ?? 0)).toEqual(["3"]);
    expect(await targetsOf(app, there?.id ?? 0)).toEqual(["1", "2", "3"]);
  });

  it("a target-decreasing change prunes roles no longer referenced from the index", async () => {
    await readyGuild(app, { "1": ["700"], "2": ["701"] });
    const p = await created("700");
    await svc.saveRoles(actor, p.id, ["700", "701"]);
    await svc.saveRoles(actor, p.id, ["701"]);
    expect([...(app.index?.referencedRoles(GUILD) ?? [])]).toEqual(["701"]);
    expect(app.index?.memberCount(GUILD)).toBe(1);
  });
});

describe("index extension (roles_grew) races — review findings", () => {
  it("a member change that happens while the extension lists members is reconciled", async () => {
    await readyGuild(app, { "200": ["700"] });
    await created("700");
    await post(app, message());
    const [t] = await autoRows(app);
    // while the extension for role 701 pages members, 201 gains @700 and 200 loses it
    let open!: () => void;
    app.discord.memberGate = new Promise<void>((r) => {
      open = r;
    });
    const saving = created("701", "601", "Other");
    await vi.advanceTimersByTimeAsync(0);
    app.discord.setMember(GUILD, "201", ["700"]);
    app.discord.setMember(GUILD, "200", []);
    const e1 = app.coordinator.onMemberEvent({
      t: "member_upsert",
      guildId: GUILD,
      userId: "201",
      roleIds: ["700"],
      bot: false,
    });
    const e2 = app.coordinator.onMemberEvent({
      t: "member_upsert",
      guildId: GUILD,
      userId: "200",
      roleIds: [],
      bot: false,
    });
    open();
    app.discord.memberGate = null;
    await Promise.all([saving, e1, e2]);
    expect(await targetsOf(app, t?.id ?? 0)).toEqual(["201"]);
  });

  it("an extension never pauses a healthy guild (no pause notice on renders meanwhile)", async () => {
    await readyGuild(app, { "1": ["700"] });
    await created("700");
    await post(app, message());
    const [t] = await autoRows(app);
    const states: string[] = [];
    let open!: () => void;
    app.discord.memberGate = new Promise<void>((r) => {
      open = r;
    });
    const saving = created("701", "601", "Other");
    await vi.advanceTimersByTimeAsync(0);
    states.push(app.autoHealth?.state(GUILD) ?? "");
    const card = await app.service.renderCard(t?.id ?? 0);
    expect(JSON.stringify(card?.body)).not.toContain("Auto-track temporarily paused");
    await vi.advanceTimersByTimeAsync(120_000); // grace would have fired
    open();
    app.discord.memberGate = null;
    await saving;
    expect(states).toEqual(["healthy"]);
    expect(app.autoHealth?.state(GUILD)).toBe("healthy");
  });
});
