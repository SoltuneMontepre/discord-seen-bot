import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplicitUserResolver } from "../../src/app/explicit-user-resolver.ts";
import {
  GuildAutoTrackHealth,
  type GuildHealthState,
} from "../../src/app/guild-auto-track-health.ts";
import { GuildQueue, NestedGuildQueueError } from "../../src/app/guild-queue.ts";
import { MemberRoleIndex } from "../../src/app/member-role-index.ts";
import { MemberStateRebuilder } from "../../src/app/member-state-rebuilder.ts";
import { RoleSourceResolver } from "../../src/app/role-source-resolver.ts";
import { TargetReconciler } from "../../src/app/target-reconciler.ts";
import { TargetResolverRegistry } from "../../src/app/target-resolution.ts";
import { PolicyRepository } from "../../src/db/policy-repository.ts";
import { RoleDeletionStore } from "../../src/db/role-deletion.ts";
import { DEFAULT_POLICY } from "../../src/domain/policy.ts";
import type { TargetSource } from "../../src/domain/target-sources.ts";
import { dateClock, memoryLogger } from "../helpers/app.ts";
import { createTestDb, newTracking } from "../helpers/db.ts";
import { MIN, T0 } from "../helpers/domain.ts";
import { FakeDiscord, permanent, transient } from "../helpers/fake-discord.ts";

const G = "500";

let ctx: Awaited<ReturnType<typeof createTestDb>>;
let discord: FakeDiscord;
let policies: PolicyRepository;
let index: MemberRoleIndex;
let health: GuildAutoTrackHealth;
let queue: GuildQueue;
let reconciler: TargetReconciler;
let rebuilder: MemberStateRebuilder;
let dirty: number[];
let logger: ReturnType<typeof memoryLogger>;
let transitions: GuildHealthState[];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  ctx = await createTestDb();
  discord = new FakeDiscord();
  policies = new PolicyRepository(ctx.db);
  index = new MemberRoleIndex();
  logger = memoryLogger();
  transitions = [];
  health = new GuildAutoTrackHealth({
    clock: dateClock,
    policy: DEFAULT_POLICY,
    onPauseNoticeDue: () => {},
    logger,
  });
  const set = health.set.bind(health);
  health.set = (g, s, d) => {
    if (g === G) transitions.push(s);
    set(g, s, d);
  };
  queue = new GuildQueue();
  dirty = [];
  const registry = new TargetResolverRegistry();
  registry.register(new ExplicitUserResolver());
  registry.register(new RoleSourceResolver(index));
  reconciler = new TargetReconciler({
    features: { roleTargets: true },
    repo: ctx.repo,
    policies,
    registry,
    health,
    queue,
    scheduler: { markDirty: (id) => dirty.push(id) },
    backfill: { enqueue: () => {} },
    policy: DEFAULT_POLICY,
    clock: dateClock,
    logger,
  });
  rebuilder = new MemberStateRebuilder({
    port: discord,
    policies,
    repo: ctx.repo,
    roleDeletion: new RoleDeletionStore(ctx.db),
    index,
    health,
    queue,
    reconciler,
    scheduler: { markDirty: (id) => dirty.push(id) },
    policy: DEFAULT_POLICY,
    clock: dateClock,
    logger,
  });
  discord.guildRoles.set(G, [G, "dev", "qa"]);
});
afterEach(async () => {
  rebuilder.dispose();
  health.dispose();
  vi.useRealTimers();
  await ctx.close();
});

/** Waits for every task queued so far for the guild (FIFO). */
const settle = (g = G) => queue.run(g, async () => {});

function policy(roleIds: string[], channelId = "600") {
  return policies.create({ guildId: G, channelId, name: "p", roleIds, actor: "9", at: T0 });
}

async function auto(targets: string[], sources: TargetSource[]) {
  const r = await ctx.repo.insertAutoTracking(newTracking({ channelType: 0 }), targets, sources);
  if (!r.ok) throw new Error("conflict");
  await ctx.repo.setStatusMessageId(r.tracked.id, `9${r.tracked.id}`);
  return r.tracked;
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

describe("MemberStateRebuilder", () => {
  it("paginates 2 500 members in 3 calls of limit 1000 with correct after cursors", async () => {
    await policy(["dev"]);
    for (let i = 0; i < 2500; i++) discord.setMember(G, String(10_001 + i), ["dev"]);
    discord.setMember(G, "20000", ["other"]);
    rebuilder.requestRebuild(G, "guild_create");
    await settle();
    const calls = discord.calls.filter((c) => c.method === "listGuildMembers").map((c) => c.args);
    expect(calls).toEqual([
      [G, undefined, 1000],
      [G, "11000", 1000],
      [G, "12000", 1000],
    ]);
    expect(index.membersOf(G, "dev")).toHaveLength(2500);
    expect(index.memberCount(G)).toBe(2500); // "other"-only member not stored
    expect(health.state(G)).toBe("healthy");
  });

  it("a member event queued during the rebuild applies after the snapshot", async () => {
    await policy(["dev"]);
    discord.setMember(G, "1", ["dev"]);
    const g = gate();
    discord.memberGate = g.p;
    rebuilder.requestRebuild(G, "guild_create");
    await vi.advanceTimersByTimeAsync(0);
    const event = queue.run(G, async () => {
      index.upsert(G, "1", [], false); // Binh loses @dev after the snapshot was taken
    });
    g.open();
    await event;
    expect(index.membersOf(G, "dev")).toEqual([]);
  });

  it("roles fetch failure → failed, nothing pruned, no target writes, retries 60s/300s/900s/900s", async () => {
    const p = await policy(["gone"]);
    const t = await auto(["1"], [{ type: "role", roleId: "gone" }]);
    discord.roleFailures.push(transient, transient, transient, transient, transient);
    rebuilder.requestRebuild(G, "guild_create");
    await settle();
    expect(health.state(G)).toBe("failed");
    expect(health.detail(G)).toMatchObject({ attempt: 1, nextRetryInMs: 60_000 });
    expect((await policies.get(p.id))?.roleIds).toEqual(["gone"]);
    expect(await ctx.repo.listTrackingSources(t.id)).toEqual([{ type: "role", roleId: "gone" }]);
    expect((await ctx.repo.listTargets(t.id)).map((x) => x.userId)).toEqual(["1"]);
    const roleCalls = () => discord.count("getGuildRoleIds");
    expect(roleCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(roleCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(roleCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(300_000);
    await settle();
    expect(roleCalls()).toBe(3);
    await vi.advanceTimersByTimeAsync(900_000);
    await settle();
    expect(roleCalls()).toBe(4);
    await vi.advanceTimersByTimeAsync(900_000);
    await settle();
    expect(roleCalls()).toBe(5);
    expect(health.detail(G)).toMatchObject({ attempt: 5, nextRetryInMs: 900_000 });
    const paused = logger.entries.filter((e) => e.msg === "auto-track paused");
    expect(paused).toHaveLength(5);
  });

  it("403 on member listing logs the Server Members intent hint", async () => {
    await policy(["dev"]);
    discord.memberFailures.push(permanent);
    rebuilder.requestRebuild(G, "guild_create");
    await settle();
    const e = logger.entries.find((x) => x.msg === "auto-track paused");
    expect(e?.obj).toMatchObject({ guildId: G, code: 50001, attempt: 1 });
    expect(JSON.stringify(e?.obj)).toMatch(/Server Members Intent/);
  });

  it("recovery order: rebuilding → reconciling → healthy; reconcile runs before healthy", async () => {
    await policy(["dev"]);
    const t = await auto(["1"], [{ type: "role", roleId: "dev" }]);
    discord.setMember(G, "1", ["dev"]);
    discord.setMember(G, "2", ["dev"]);
    const seen: GuildHealthState[] = [];
    const original = reconciler.reconcileGuildInQueue.bind(reconciler);
    reconciler.reconcileGuildInQueue = async (g, o) => {
      seen.push(health.state(g));
      return original(g, o);
    };
    vi.advanceTimersByTime(5 * MIN);
    rebuilder.requestRebuild(G, "guild_create");
    await settle();
    expect(transitions).toEqual(["rebuilding", "reconciling", "healthy"]);
    expect(seen).toEqual(["reconciling"]);
    expect((await ctx.repo.listTargets(t.id)).map((x) => x.userId).sort()).toEqual(["1", "2"]);
    const resumed = logger.entries.find((e) => e.msg === "auto-track resumed");
    expect(resumed?.obj).toMatchObject({ guildId: G, attempt: 0 });
    expect(dirty).toContain(t.id);
  });

  it("resume marks only role-dependent active auto cards dirty", async () => {
    await policy(["dev"], "600");
    const inPolicyChannel = await auto(["1"], [{ type: "user", userId: "1" }]);
    const r = await ctx.repo.insertAutoTracking(
      newTracking({ channelType: 0, channelId: "601" }),
      ["2"],
      [{ type: "user", userId: "2" }],
    );
    if (!r.ok) throw new Error();
    discord.setMember(G, "1", ["dev"]);
    rebuilder.requestRebuild(G, "guild_create");
    await settle();
    expect(dirty).toContain(inPolicyChannel.id);
    expect(dirty).not.toContain(r.tracked.id);
  });

  it("DB failure during reconcile stays reconciling, retries after 60s without REST", async () => {
    await policy(["dev"]);
    discord.setMember(G, "1", ["dev"]);
    const spy = vi
      .spyOn(reconciler, "reconcileGuildInQueue")
      .mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    rebuilder.requestRebuild(G, "guild_create");
    await settle();
    expect(health.state(G)).toBe("reconciling");
    const rest = () => discord.count("listGuildMembers") + discord.count("getGuildRoleIds");
    const before = rest();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(health.state(G)).toBe("healthy");
    expect(rest()).toBe(before);
  });

  it("global concurrency: two guilds page members one at a time", async () => {
    await policy(["dev"]);
    await policies.create({
      guildId: "501",
      channelId: "700",
      name: "p",
      roleIds: ["x"],
      actor: "9",
      at: T0,
    });
    discord.guildRoles.set("501", ["501", "x"]);
    discord.setMember(G, "1", ["dev"]);
    discord.setMember("501", "2", ["x"]);
    const g = gate();
    discord.memberGate = g.p;
    rebuilder.requestRebuild(G, "guild_create");
    rebuilder.requestRebuild("501", "guild_create");
    await vi.advanceTimersByTimeAsync(0);
    expect(discord.count("listGuildMembers")).toBe(1);
    g.open();
    discord.memberGate = null;
    await settle(G);
    await settle("501");
    expect(discord.count("listGuildMembers")).toBe(2);
    expect(health.state("501")).toBe("healthy");
  });

  it("offline-deleted role pruning during a rebuild completes without nested queue calls", async () => {
    const p = await policy(["gone"]);
    const t = await auto(
      ["1", "2"],
      [
        { type: "user", userId: "1" },
        { type: "role", roleId: "gone" },
      ],
    );
    const runSpy = vi.spyOn(queue, "run");
    const keyedSpy = vi.spyOn(queue, "runKeyed");
    const result = await queue.run(G, async () => {
      runSpy.mockClear();
      keyedSpy.mockClear();
      return rebuilder.rebuildNowInQueue(G, "guild_create");
    });
    expect(result).toBe("healthy");
    expect(runSpy).not.toHaveBeenCalled();
    expect(keyedSpy).not.toHaveBeenCalled();
    expect(await policies.get(p.id)).toMatchObject({
      state: "auto_disabled_missing_role",
      roleIds: [],
    });
    expect(await ctx.repo.listTrackingSources(t.id)).toEqual([{ type: "user", userId: "1" }]);
    expect((await ctx.repo.listTargets(t.id)).map((x) => x.userId)).toEqual(["1"]);
  });

  it("rebuildNowInQueue outside a queue task throws; inside it resolves", async () => {
    await expect(rebuilder.rebuildNowInQueue(G, "guild_create")).rejects.toThrow(/not inside/);
    await expect(queue.run(G, () => rebuilder.rebuildNowInQueue(G, "guild_create"))).resolves.toBe(
      "healthy",
    );
    await expect(queue.run(G, () => queue.run(G, async () => {}))).rejects.toBeInstanceOf(
      NestedGuildQueueError,
    );
  });

  it("roles_grew with extraReferencedRoleIds indexes the new role and skips the reconcile", async () => {
    discord.setMember(G, "1", ["qa"]);
    const spy = vi.spyOn(reconciler, "reconcileGuildInQueue");
    const r = await queue.run(G, () =>
      rebuilder.rebuildNowInQueue(G, "roles_grew", {
        extraReferencedRoleIds: ["qa"],
        reconcile: false,
      }),
    );
    expect(r).toBe("healthy");
    expect(index.membersOf(G, "qa")).toEqual([{ userId: "1", bot: false }]);
    expect(spy).not.toHaveBeenCalled();
    expect(health.state(G)).toBe("healthy");
  });

  it("requestRebuild twice while one is running → exactly one trailing rebuild", async () => {
    await policy(["dev"]);
    const g = gate();
    discord.memberGate = g.p;
    rebuilder.requestRebuild(G, "guild_create");
    await vi.advanceTimersByTimeAsync(0);
    rebuilder.requestRebuild(G, "guild_create");
    rebuilder.requestRebuild(G, "guild_create");
    g.open();
    discord.memberGate = null;
    await settle();
    await settle();
    expect(discord.count("getGuildRoleIds")).toBe(2);
  });

  it("a guild with no role work becomes healthy without REST calls", async () => {
    await auto(["1"], [{ type: "user", userId: "1" }]);
    expect(await rebuilder.needsRebuild(G)).toBe(false);
    rebuilder.requestRebuild(G, "guild_create");
    await settle();
    expect(health.state(G)).toBe("healthy");
    expect(discord.count("getGuildRoleIds") + discord.count("listGuildMembers")).toBe(0);
  });

  it("needsRebuild: enabled role policies or active message-role trackings", async () => {
    expect(await rebuilder.needsRebuild(G)).toBe(false);
    const p = await policy(["dev"]);
    expect(await rebuilder.needsRebuild(G)).toBe(true);
    await policies.setState(p.id, "user_disabled", "9", T0);
    expect(await rebuilder.needsRebuild(G)).toBe(false);
    await auto(["1"], [{ type: "role", roleId: "dev" }]);
    expect(await rebuilder.needsRebuild(G)).toBe(true);
  });

  it("manual tracking acknowledge works while the guild is failed", async () => {
    await policy(["dev"]);
    discord.roleFailures.push(transient);
    rebuilder.requestRebuild(G, "guild_create");
    await settle();
    expect(health.state(G)).toBe("failed");
    const m = await ctx.repo.insertTracking(newTracking(), ["1"]);
    if (!m.ok) throw new Error();
    expect(await ctx.repo.acknowledge(m.tracked.id, "1", T0 + MIN)).toEqual({
      result: "acknowledged",
    });
  });

  it("dispose cancels scheduled retries", async () => {
    await policy(["dev"]);
    discord.roleFailures.push(transient);
    rebuilder.requestRebuild(G, "guild_create");
    await settle();
    rebuilder.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(discord.count("getGuildRoleIds")).toBe(1);
  });
});
