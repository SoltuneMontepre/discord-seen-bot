import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PolicyRepository } from "../../src/db/policy-repository.ts";
import type { Repository } from "../../src/db/repository.ts";
import { RoleDeletionStore } from "../../src/db/role-deletion.ts";
import type { TargetSource } from "../../src/domain/target-sources.ts";
import { createTestDb, newTracking } from "../helpers/db.ts";
import { MIN, T0 } from "../helpers/domain.ts";

let ctx: Awaited<ReturnType<typeof createTestDb>>;
let repo: Repository;
let policies: PolicyRepository;
let store: RoleDeletionStore;
const AT = T0 + 10 * MIN;

beforeEach(async () => {
  ctx = await createTestDb();
  repo = ctx.repo;
  policies = new PolicyRepository(ctx.db);
  store = new RoleDeletionStore(ctx.db);
});
afterEach(async () => ctx.close());

function policy(roleIds: string[], o: { guildId?: string; channelId?: string } = {}) {
  return policies.create({
    guildId: o.guildId ?? "500",
    channelId: o.channelId ?? "600",
    name: "p",
    roleIds,
    actor: "100",
    at: T0,
  });
}

async function auto(sources: TargetSource[], overrides = {}) {
  const r = await repo.insertAutoTracking(newTracking(overrides), ["1"], sources);
  if (!r.ok) throw new Error("conflict");
  return r.tracked;
}

async function snapshot() {
  const q = async (text: string) => (await sql.raw(text).execute(ctx.db)).rows;
  return {
    policies: await q(
      "SELECT id, state, state_changed_at, state_changed_by FROM auto_track_policies ORDER BY id",
    ),
    policySources: await q(
      "SELECT * FROM auto_track_policy_sources ORDER BY policy_id, source_ref",
    ),
    trackingSources: await q(
      "SELECT * FROM tracking_sources ORDER BY tracked_message_id, source_type, source_ref",
    ),
  };
}

describe("RoleDeletionStore.apply", () => {
  it("enabled policy losing its only role → auto_disabled_missing_role, state_changed_by '0'", async () => {
    const p = await policy(["700"]);
    const r = await store.apply("500", "700", AT);
    expect(await policies.get(p.id)).toMatchObject({
      state: "auto_disabled_missing_role",
      roleIds: [],
      stateChangedAt: AT,
      stateChangedBy: "0",
      updatedAt: AT,
      updatedByUserId: "0",
    });
    expect(r.affectedPolicyIds).toEqual([p.id]);
    expect(r.autoDisabledPolicyIds).toEqual([p.id]);
    expect(r.affectedChannelIds).toEqual(["600"]);
  });

  it("enabled policy with another role left → stays enabled", async () => {
    const p = await policy(["700", "701"]);
    const r = await store.apply("500", "700", AT);
    expect(await policies.get(p.id)).toMatchObject({
      state: "enabled",
      roleIds: ["701"],
      stateChangedAt: T0,
      stateChangedBy: "100",
    });
    expect(r.autoDisabledPolicyIds).toEqual([]);
  });

  it("user_disabled policy losing its last role → stays user_disabled", async () => {
    const p = await policy(["700"]);
    await policies.setState(p.id, "user_disabled", "101", T0 + MIN);
    const r = await store.apply("500", "700", AT);
    expect(await policies.get(p.id)).toMatchObject({
      state: "user_disabled",
      roleIds: [],
      stateChangedBy: "101",
    });
    expect(r.autoDisabledPolicyIds).toEqual([]);
    // a disabled policy contributes no live targets, so its channel needs no reconcile
    expect(r.affectedChannelIds).toEqual([]);
  });

  it("deletes the guild's active tracking_sources role rows only", async () => {
    const a = await auto([
      { type: "role", roleId: "700" },
      { type: "user", userId: "1" },
    ]);
    const other = await auto([{ type: "role", roleId: "700" }], { guildId: "501" });
    const stopped = await auto([{ type: "role", roleId: "700" }]);
    await repo.stopAuto(stopped.id, "feature_disabled", T0);
    const userSameRef = await auto([{ type: "user", userId: "700" }]);
    const r = await store.apply("500", "700", AT);
    expect(await repo.listTrackingSources(a.id)).toEqual([{ type: "user", userId: "1" }]);
    expect(await repo.listTrackingSources(other.id)).toEqual([{ type: "role", roleId: "700" }]);
    expect(await repo.listTrackingSources(stopped.id)).toEqual([{ type: "role", roleId: "700" }]);
    expect(await repo.listTrackingSources(userSameRef.id)).toEqual([
      { type: "user", userId: "700" },
    ]);
    expect(r.affectedTrackingIds).toEqual([a.id]);
  });

  it("other guild's identical role id in a policy is untouched", async () => {
    const mine = await policy(["700"], { channelId: "600" });
    const theirs = await policy(["700"], { guildId: "501", channelId: "602" });
    const r = await store.apply("500", "700", AT);
    expect(r.affectedPolicyIds).toEqual([mine.id]);
    expect(await policies.get(theirs.id)).toMatchObject({ state: "enabled", roleIds: ["700"] });
  });

  it("returns affected policy/channel/tracking ids across channels", async () => {
    const a = await policy(["700"], { channelId: "600" });
    const b = await policy(["700", "701"], { channelId: "601" });
    const t = await auto([{ type: "role", roleId: "700" }]);
    const r = await store.apply("500", "700", AT);
    expect(r).toEqual({
      affectedPolicyIds: [a.id, b.id],
      autoDisabledPolicyIds: [a.id],
      affectedChannelIds: ["600", "601"],
      affectedTrackingIds: [t.id],
    });
  });

  it("idempotent: a second apply → empty result, no writes", async () => {
    await policy(["700"]);
    await auto([{ type: "role", roleId: "700" }]);
    await store.apply("500", "700", AT);
    const before = await snapshot();
    const changes = await sql<{ n: number }>`SELECT total_changes() AS n`.execute(ctx.db);
    expect(await store.apply("500", "700", AT + MIN)).toEqual({
      affectedPolicyIds: [],
      autoDisabledPolicyIds: [],
      affectedChannelIds: [],
      affectedTrackingIds: [],
    });
    const after = await sql<{ n: number }>`SELECT total_changes() AS n`.execute(ctx.db);
    expect(after.rows[0]?.n).toBe(changes.rows[0]?.n);
    expect(await snapshot()).toEqual(before);
  });

  it("injected failure after policy steps rolls back everything", async () => {
    await policy(["700"]);
    await policy(["700", "701"], { channelId: "601" });
    await auto([{ type: "role", roleId: "700" }]);
    const before = await snapshot();
    await sql`CREATE TRIGGER fail_ts BEFORE DELETE ON tracking_sources
      BEGIN SELECT RAISE(ABORT, 'boom'); END`.execute(ctx.db);
    await expect(store.apply("500", "700", AT)).rejects.toThrow(/boom/);
    expect(await snapshot()).toEqual(before);
    await sql`DROP TRIGGER fail_ts`.execute(ctx.db);
    const r = await store.apply("500", "700", AT);
    expect(r.affectedPolicyIds).toHaveLength(2);
    expect(r.affectedTrackingIds).toHaveLength(1);
  });
});
