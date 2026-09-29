import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PolicyRepository } from "../../src/db/policy-repository.ts";
import { createTestDb } from "../helpers/db.ts";
import { MIN, T0 } from "../helpers/domain.ts";

let ctx: Awaited<ReturnType<typeof createTestDb>>;
let policies: PolicyRepository;

beforeEach(async () => {
  ctx = await createTestDb();
  policies = new PolicyRepository(ctx.db);
});
afterEach(async () => ctx.close());

function create(roleIds: string[], overrides: { guildId?: string; channelId?: string } = {}) {
  return policies.create({
    guildId: overrides.guildId ?? "500",
    channelId: overrides.channelId ?? "600",
    name: "Dev",
    roleIds,
    actor: "100",
    at: T0,
  });
}

async function sourceRows() {
  return (
    await sql<{ policy_id: number; source_ref: string }>`
      SELECT policy_id, source_ref FROM auto_track_policy_sources ORDER BY policy_id, source_ref`.execute(
      ctx.db,
    )
  ).rows;
}

describe("PolicyRepository", () => {
  it("create persists roles; multiple policies per channel; multiple roles per policy", async () => {
    const a = await create(["700", "701"]);
    const b = await create(["702"]);
    expect(a).toEqual({
      id: a.id,
      guildId: "500",
      channelId: "600",
      name: "Dev",
      state: "enabled",
      roleIds: ["700", "701"],
      stateChangedAt: T0,
      stateChangedBy: "100",
      createdAt: T0,
      createdByUserId: "100",
      updatedAt: T0,
      updatedByUserId: "100",
    });
    expect(b.id).toBeGreaterThan(a.id);
    expect(await policies.get(a.id)).toEqual(a);
    expect(await policies.get(999)).toBeUndefined();
    expect(await policies.countForChannel("600")).toBe(2);
  });

  it("enabledRoleIdsForChannel returns the union of enabled policies only, deduped", async () => {
    await create(["700", "701"]);
    await create(["701", "702"]);
    await create(["703"], { channelId: "601" });
    expect((await policies.enabledRoleIdsForChannel("600")).sort()).toEqual(["700", "701", "702"]);
  });

  it("user_disabled and auto_disabled policies are excluded", async () => {
    const a = await create(["700"]);
    const b = await create(["701"]);
    await create(["702"]);
    await policies.setState(a.id, "user_disabled", "101", T0 + MIN);
    await policies.setState(b.id, "auto_disabled_missing_role", "0", T0 + MIN);
    expect(await policies.enabledRoleIdsForChannel("600")).toEqual(["702"]);
    expect(await policies.referencedRoleIds("500")).toEqual(["702"]);
    const after = await policies.get(a.id);
    expect(after).toMatchObject({
      state: "user_disabled",
      stateChangedAt: T0 + MIN,
      stateChangedBy: "101",
      updatedAt: T0 + MIN,
      updatedByUserId: "101",
      createdByUserId: "100",
    });
  });

  it("enabledChannelIdsForRoles returns channels whose enabled policies contain any role", async () => {
    await create(["700"], { channelId: "600" });
    await create(["701"], { channelId: "601" });
    const off = await create(["700"], { channelId: "602" });
    await policies.setState(off.id, "user_disabled", "100", T0);
    await create(["700"], { guildId: "501", channelId: "603" });
    expect((await policies.enabledChannelIdsForRoles("500", ["700", "701"])).sort()).toEqual([
      "600",
      "601",
    ]);
    expect(await policies.enabledChannelIdsForRoles("500", [])).toEqual([]);
  });

  it("referencedRoleIds: distinct roles of the guild's enabled policies", async () => {
    await create(["700", "701"]);
    await create(["701"], { channelId: "601" });
    await create(["709"], { guildId: "501" });
    expect((await policies.referencedRoleIds("500")).sort()).toEqual(["700", "701"]);
  });

  it("allRoleIds: distinct roles of all the guild's policies, any state", async () => {
    const off = await create(["700"]);
    await policies.setState(off.id, "user_disabled", "100", T0);
    await create(["701", "700"], { channelId: "601" });
    await create(["709"], { guildId: "501" });
    expect(await policies.allRoleIds("500")).toEqual(["700", "701"]);
  });

  it("saveRolesAndState replaces roles in one txn, keeping added_at of kept roles", async () => {
    const a = await create(["700", "701"]);
    await policies.saveRolesAndState(a.id, ["701", "702"], "enabled", "101", T0 + MIN);
    const got = await policies.get(a.id);
    expect(got?.roleIds).toEqual(["701", "702"]);
    expect(got).toMatchObject({
      state: "enabled",
      stateChangedAt: T0, // state unchanged → state_changed_* untouched
      stateChangedBy: "100",
      updatedAt: T0 + MIN,
      updatedByUserId: "101",
    });
    const rows = (
      await sql<{ source_ref: string; added_at: number; added_by_user_id: string }>`
        SELECT source_ref, added_at, added_by_user_id FROM auto_track_policy_sources
        ORDER BY source_ref`.execute(ctx.db)
    ).rows;
    expect(rows).toEqual([
      { source_ref: "701", added_at: T0, added_by_user_id: "100" },
      { source_ref: "702", added_at: T0 + MIN, added_by_user_id: "101" },
    ]);
    await policies.saveRolesAndState(a.id, ["702"], "user_disabled", "102", T0 + 2 * MIN);
    expect(await policies.get(a.id)).toMatchObject({
      roleIds: ["702"],
      state: "user_disabled",
      stateChangedAt: T0 + 2 * MIN,
      stateChangedBy: "102",
    });
  });

  it("rename updates name and updated_* only", async () => {
    const a = await create(["700"]);
    await policies.rename(a.id, "QA", "101", T0 + MIN);
    expect(await policies.get(a.id)).toMatchObject({
      name: "QA",
      updatedAt: T0 + MIN,
      updatedByUserId: "101",
      stateChangedBy: "100",
    });
  });

  it("delete removes the policy and its sources", async () => {
    const a = await create(["700"]);
    const b = await create(["701"]);
    await policies.delete(a.id);
    expect(await policies.get(a.id)).toBeUndefined();
    expect(await sourceRows()).toEqual([{ policy_id: b.id, source_ref: "701" }]);
  });

  it("listForChannel paginates by id; countForChannel counts all", async () => {
    for (let i = 0; i < 30; i++) await create([String(700 + i)]);
    await create(["800"], { channelId: "601" });
    const ids = async (offset: number) =>
      (await policies.listForChannel("600", { offset, limit: 10 })).map((p) => p.id);
    const first = await ids(0);
    expect(first).toHaveLength(10);
    expect(first).toEqual([...first].sort((x, y) => x - y));
    expect(await ids(20)).toEqual(Array.from({ length: 10 }, (_, i) => (first[0] ?? 0) + 20 + i));
    expect(await ids(30)).toEqual([]);
    expect(await policies.countForChannel("600")).toBe(30);
    const page = await policies.listForChannel("600", { offset: 0, limit: 1 });
    expect(page[0]?.roleIds).toEqual(["700"]);
  });

  it("deleteChannelPolicies deletes only that channel's policies + sources", async () => {
    await create(["700"], { channelId: "600" });
    await create(["701"], { channelId: "600" });
    const keep = await create(["702"], { channelId: "601" });
    const other = await create(["703"], { guildId: "501", channelId: "602" });
    expect(await policies.deleteChannelPolicies("600")).toBe(2);
    expect(await sourceRows()).toEqual([
      { policy_id: keep.id, source_ref: "702" },
      { policy_id: other.id, source_ref: "703" },
    ]);
    expect(await policies.deleteChannelPolicies("600")).toBe(0);
  });

  it("purgeGuild deletes only that guild's policies + sources", async () => {
    await create(["700"], { channelId: "600" });
    await create(["701"], { channelId: "601" });
    const other = await create(["702"], { guildId: "501", channelId: "602" });
    expect(await policies.purgeGuild("500")).toBe(2);
    expect(await sourceRows()).toEqual([{ policy_id: other.id, source_ref: "702" }]);
  });
});
