import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackfillQueue } from "../../src/app/backfill-queue.ts";
import { ExplicitUserResolver } from "../../src/app/explicit-user-resolver.ts";
import { GuildAutoTrackHealth } from "../../src/app/guild-auto-track-health.ts";
import { GuildQueue } from "../../src/app/guild-queue.ts";
import { MemberRoleIndex } from "../../src/app/member-role-index.ts";
import { RoleSourceResolver } from "../../src/app/role-source-resolver.ts";
import { TargetReconciler } from "../../src/app/target-reconciler.ts";
import { TargetResolverRegistry } from "../../src/app/target-resolution.ts";
import { PolicyRepository } from "../../src/db/policy-repository.ts";
import type { TargetSource } from "../../src/domain/target-sources.ts";
import { memoryLogger } from "../helpers/app.ts";
import { createTestDb, newTracking } from "../helpers/db.ts";
import { MIN, T0 } from "../helpers/domain.ts";

const G = "500";
const TEXT = 0;
const PUBLIC_THREAD = 11;

let ctx: Awaited<ReturnType<typeof createTestDb>>;
let policies: PolicyRepository;
let index: MemberRoleIndex;
let health: GuildAutoTrackHealth;
let queue: GuildQueue;
let dirty: number[];
let backfilled: { id: number; users: string[] }[];
let now: number;
let reconciler: TargetReconciler;
let logger: ReturnType<typeof memoryLogger>;

function build(limit = 100) {
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
    backfill: { enqueue: (id, users) => backfilled.push({ id, users: [...users] }) },
    policy: { autoTrackMaxTargets: limit },
    clock: { now: () => now },
    logger,
  });
}

beforeEach(async () => {
  ctx = await createTestDb();
  policies = new PolicyRepository(ctx.db);
  index = new MemberRoleIndex();
  index.setReferencedRoles(G, ["dev", "qa"]);
  logger = memoryLogger();
  health = new GuildAutoTrackHealth({
    clock: { now: () => now },
    policy: { pauseNoticeGraceMs: 60_000 },
    onPauseNoticeDue: () => {},
    logger,
  });
  health.set(G, "healthy");
  queue = new GuildQueue();
  dirty = [];
  backfilled = [];
  now = T0 + 10 * MIN;
  build();
});
afterEach(async () => {
  health.dispose();
  await ctx.close();
});

function members(m: Record<string, string[]>) {
  index.replaceSnapshot(
    G,
    Object.entries(m).map(([userId, roleIds]) => ({ userId, roleIds, bot: false })),
  );
}

async function auto(
  targets: string[],
  sources: TargetSource[],
  o: { channelId?: string; channelType?: number } = {},
) {
  const r = await ctx.repo.insertAutoTracking(
    newTracking({ channelType: o.channelType ?? TEXT, channelId: o.channelId ?? "600" }),
    targets,
    sources,
  );
  if (!r.ok) throw new Error("conflict");
  await ctx.repo.setStatusMessageId(r.tracked.id, `9${r.tracked.id}`);
  return r.tracked;
}

const inQueue = <T>(fn: () => Promise<T>) => queue.run(G, fn);
const reconcile = (id: number) => inQueue(() => reconciler.reconcileInQueue(id));
const targetIds = async (id: number) =>
  (await ctx.repo.listTargets(id)).map((t) => t.userId).sort();
const role = (roleId: string): TargetSource => ({ type: "role", roleId });
const user = (userId: string): TargetSource => ({ type: "user", userId });

describe("TargetReconciler", () => {
  it("role gained → added with fresh addedAt, card dirty, backfill for added", async () => {
    members({ "1": ["dev"] });
    const t = await auto(["1"], [role("dev")]);
    members({ "1": ["dev"], "2": ["dev"] });
    expect(await reconcile(t.id)).toBe("changed");
    const added = (await ctx.repo.listTargets(t.id)).find((x) => x.userId === "2");
    expect(added).toEqual({ userId: "2", addedByUserId: "0", addedAt: now });
    expect(dirty).toEqual([t.id]);
    expect(backfilled).toEqual([{ id: t.id, users: ["2"] }]);
  });

  it("role lost with no other source → removed with evidence and ack", async () => {
    members({ "1": ["dev"], "2": ["dev"] });
    const t = await auto(["1", "2"], [role("dev")]);
    await ctx.repo.acknowledge(t.id, "2", T0 + MIN);
    members({ "1": ["dev"] });
    expect(await reconcile(t.id)).toBe("changed");
    expect(await targetIds(t.id)).toEqual(["1"]);
    expect(await ctx.repo.getAck(t.id, "2")).toBeUndefined();
    expect(backfilled).toEqual([]);
  });

  it("explicit source keeps the user after role loss; a second role keeps the user", async () => {
    members({ "1": ["dev"], "2": ["dev", "qa"], "3": ["dev"] });
    const t = await auto(["1", "2", "3"], [user("1"), role("dev"), role("qa")]);
    members({ "3": ["dev"], "2": ["qa"] });
    expect(await reconcile(t.id)).toBe("unchanged");
    expect(await targetIds(t.id)).toEqual(["1", "2", "3"]);
  });

  it("mentioned role + policy role overlap → one target", async () => {
    members({ "1": ["dev"] });
    await policies.create({
      guildId: G,
      channelId: "600",
      name: "p",
      roleIds: ["dev"],
      actor: "9",
      at: T0,
    });
    const t = await auto(["1"], [role("dev")]);
    expect(await reconciler.sourcesFor(t)).toEqual([role("dev")]);
    expect(await reconcile(t.id)).toBe("unchanged");
  });

  it("policy roles apply to the exact text channel", async () => {
    members({ "1": ["dev"], "2": ["qa"] });
    await policies.create({
      guildId: G,
      channelId: "600",
      name: "p",
      roleIds: ["qa"],
      actor: "9",
      at: T0,
    });
    const t = await auto(["1"], [role("dev")]);
    expect(await reconcile(t.id)).toBe("changed");
    expect(await targetIds(t.id)).toEqual(["1", "2"]);
  });

  it("zero → destructive stop no_eligible_targets", async () => {
    members({ "1": ["dev"] });
    const t = await auto(["1"], [role("dev")]);
    members({});
    expect(await reconcile(t.id)).toBe("stopped");
    expect(await targetIds(t.id)).toEqual([]);
    expect((await ctx.repo.getTracked(t.id))?.stopReason).toBe("no_eligible_targets");
    expect(dirty).toEqual([t.id]);
  });

  it("desired 101 → target_limit_exceeded, stored targets unchanged", async () => {
    members({ "1000": ["dev"] });
    const t = await auto(["1000"], [role("dev")]);
    await ctx.repo.acknowledge(t.id, "1000", T0 + MIN);
    const before = await ctx.repo.loadView(t.id);
    // 101 eligible members (the author "100" is not among them)
    members(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(1000 + i), ["dev"]])));
    expect(await reconcile(t.id)).toBe("limit_stopped");
    const after = await ctx.repo.loadView(t.id);
    expect(after?.targets).toEqual(before?.targets);
    expect(after?.acks).toEqual(before?.acks);
    expect(after?.tracked.stopReason).toBe("target_limit_exceeded");
    expect(dirty).toEqual([t.id]);
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
  });

  it("exactly at the limit → reconciles normally", async () => {
    build(2);
    members({ "1": ["dev"] });
    const t = await auto(["1"], [role("dev")]);
    members({ "1": ["dev"], "2": ["dev"] });
    expect(await reconcile(t.id)).toBe("changed");
  });

  it("stopped tracking → inactive (never revived); manual tracking untouched", async () => {
    members({ "1": ["dev"], "2": ["dev"] });
    const t = await auto(["1"], [role("dev")]);
    await ctx.repo.stopAuto(t.id, "feature_disabled", T0);
    expect(await reconcile(t.id)).toBe("inactive");
    const m = await ctx.repo.insertTracking(newTracking(), ["5"]);
    if (!m.ok) throw new Error();
    expect(await reconcile(m.tracked.id)).toBe("inactive");
    expect(await targetIds(m.tracked.id)).toEqual(["5"]);
    expect(await reconcile(999)).toBe("inactive");
  });

  it("paused + role-dependent → skipped_paused, no writes", async () => {
    members({ "1": ["dev"] });
    const t = await auto(["1"], [role("dev")]);
    members({});
    health.set(G, "failed");
    expect(await reconcile(t.id)).toBe("skipped_paused");
    expect(await targetIds(t.id)).toEqual(["1"]);
    expect(dirty).toEqual([]);
  });

  it("paused + policy channel makes an explicit-only tracking role-dependent", async () => {
    await policies.create({
      guildId: G,
      channelId: "600",
      name: "p",
      roleIds: ["dev"],
      actor: "9",
      at: T0,
    });
    const t = await auto(["1"], [user("1")]);
    health.set(G, "failed");
    expect(await reconcile(t.id)).toBe("skipped_paused");
  });

  it("paused + explicit-only → reconciles", async () => {
    const t = await auto(["1"], [user("1")]);
    health.set(G, "failed");
    expect(await reconcile(t.id)).toBe("unchanged");
  });

  it("ignorePause (recovery reconcile) applies role-dependent diffs while reconciling", async () => {
    members({ "1": ["dev"] });
    const t = await auto(["1"], [role("dev")]);
    members({ "2": ["dev"] });
    health.set(G, "reconciling");
    await inQueue(() => reconciler.reconcileGuildInQueue(G, { ignorePause: true }));
    expect(await targetIds(t.id)).toEqual(["2"]);
  });

  it("thread tracking ignores policies (parent's and even its own channel id)", async () => {
    members({ "1": ["dev"], "2": ["qa"] });
    await policies.create({
      guildId: G,
      channelId: "600",
      name: "parent",
      roleIds: ["qa"],
      actor: "9",
      at: T0,
    });
    await policies.create({
      guildId: G,
      channelId: "thread",
      name: "odd",
      roleIds: ["qa"],
      actor: "9",
      at: T0,
    });
    const t = await auto(["1"], [role("dev")], { channelId: "thread", channelType: PUBLIC_THREAD });
    expect(await reconciler.sourcesFor(t)).toEqual([role("dev")]);
    expect(await reconcile(t.id)).toBe("unchanged");
  });

  it("missing channel_type (NULL) → policy roles never apply (fail closed)", async () => {
    members({ "2": ["qa"] });
    await policies.create({
      guildId: G,
      channelId: "600",
      name: "p",
      roleIds: ["qa"],
      actor: "9",
      at: T0,
    });
    const r = await ctx.repo.insertAutoTracking(
      newTracking({ channelType: null }),
      ["1"],
      [user("1")],
    );
    if (!r.ok) throw new Error();
    expect(await reconciler.sourcesFor(r.tracked)).toEqual([user("1")]);
  });

  it("roles flag off: role rows and policies are ignored by sourcesFor", async () => {
    await policies.create({
      guildId: G,
      channelId: "600",
      name: "p",
      roleIds: ["qa"],
      actor: "9",
      at: T0,
    });
    const t = await auto(["1"], [user("1"), role("dev")]);
    const registry = new TargetResolverRegistry();
    registry.register(new ExplicitUserResolver());
    const off = new TargetReconciler({
      features: { roleTargets: false },
      repo: ctx.repo,
      policies,
      registry,
      health: undefined,
      queue,
      scheduler: { markDirty: () => {} },
      backfill: { enqueue: () => {} },
      policy: { autoTrackMaxTargets: 100 },
      clock: { now: () => now },
      logger,
    });
    expect(await off.sourcesFor(t)).toEqual([user("1")]);
  });

  it("reconcileChannelInQueue covers only that channel's active auto trackings", async () => {
    members({ "1": ["dev"], "2": ["dev"] });
    const a = await auto(["1"], [role("dev")], { channelId: "600" });
    const b = await auto(["1"], [role("dev")], { channelId: "601" });
    await inQueue(() => reconciler.reconcileChannelInQueue(G, "600"));
    expect(await targetIds(a.id)).toEqual(["1", "2"]);
    expect(await targetIds(b.id)).toEqual(["1"]);
    await inQueue(() => reconciler.reconcileGuildInQueue(G));
    expect(await targetIds(b.id)).toEqual(["1", "2"]);
  });

  it("…InQueue methods refuse to run outside the guild queue", async () => {
    const t = await auto(["1"], [user("1")]);
    await expect(reconciler.reconcileInQueue(t.id)).rejects.toThrow(/not inside/);
    await expect(reconciler.reconcileChannelInQueue(G, "600")).rejects.toThrow(/not inside/);
    await expect(reconciler.reconcileGuildInQueue(G)).rejects.toThrow(/not inside/);
  });
});

describe("BackfillQueue", () => {
  it("bounded to 2 concurrent and coalesces users per tracking", async () => {
    const releases: (() => void)[] = [];
    const calls: { id: number; users: string[] }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const q = new BackfillQueue({
      concurrency: 2,
      logger,
      backfill: async (id, users) => {
        calls.push({ id, users: [...users].sort() });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((r) => releases.push(r));
        inFlight--;
      },
    });
    q.enqueue(1, ["a"]);
    q.enqueue(2, ["b"]);
    q.enqueue(3, ["c"]);
    await new Promise((r) => setImmediate(r)); // 1 and 2 are running, 3 is pending
    expect(calls.map((c) => c.id)).toEqual([1, 2]);
    q.enqueue(3, ["d"]); // coalesced into the pending run for 3
    q.enqueue(1, ["e"]); // 1 is running → a new pending run for 1
    q.enqueue(1, []); // no users → ignored
    const drain = async () => {
      while (calls.length < 4 || inFlight > 0) {
        await new Promise((r) => setImmediate(r));
        releases.shift()?.();
      }
    };
    await drain();
    await q.idle();
    expect(maxInFlight).toBe(2);
    expect(calls).toEqual([
      { id: 1, users: ["a"] },
      { id: 2, users: ["b"] },
      { id: 3, users: ["c", "d"] },
      { id: 1, users: ["e"] },
    ]);
  });

  it("a failing backfill is logged and does not block the queue; dispose drops pending work", async () => {
    const seen: number[] = [];
    const q = new BackfillQueue({
      concurrency: 1,
      logger,
      backfill: async (id) => {
        seen.push(id);
        if (id === 1) throw new Error("boom");
      },
    });
    q.enqueue(1, ["a"]);
    q.enqueue(2, ["b"]);
    await q.idle();
    expect(seen).toEqual([1, 2]);
    expect(logger.entries.some((e) => e.level === "warn")).toBe(true);
    q.dispose();
    q.enqueue(3, ["c"]);
    await q.idle();
    expect(seen).toEqual([1, 2]);
  });
});
