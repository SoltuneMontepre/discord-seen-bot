import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Repository } from "../../src/db/repository.ts";
import type { TargetSource } from "../../src/domain/target-sources.ts";
import { createTestDb, newTracking } from "../helpers/db.ts";
import { MIN, T0 } from "../helpers/domain.ts";

let ctx: Awaited<ReturnType<typeof createTestDb>>;
let repo: Repository;
const always = () => true;

beforeEach(async () => {
  ctx = await createTestDb();
  repo = ctx.repo;
});
afterEach(async () => ctx.close());

async function auto(
  targets: string[] = ["1", "2"],
  sources: TargetSource[] = [{ type: "user", userId: "1" }],
  overrides = {},
) {
  const r = await repo.insertAutoTracking(
    newTracking({ channelType: 0, ...overrides }),
    targets,
    sources,
  );
  if (!r.ok) throw new Error("conflict");
  await repo.setStatusMessageId(r.tracked.id, `9${r.tracked.id}`);
  return r.tracked;
}

async function manual(targets = ["1", "2"], overrides = {}) {
  const r = await repo.insertTracking(newTracking(overrides), targets);
  if (!r.ok) throw new Error("conflict");
  await repo.setStatusMessageId(r.tracked.id, `9${r.tracked.id}`);
  return r.tracked;
}

async function count(table: string, id: number): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT count(*) AS n FROM ${sql.table(table)} WHERE tracked_message_id = ${id}`.execute(ctx.db);
  return Number(r.rows[0]?.n);
}

async function withHistory(id: number, user: string) {
  await repo.recordEvidence(
    {
      trackedMessageId: id,
      userId: user,
      kind: "DIRECT_REPLY",
      sourceKey: `r${user}`,
      occurredAt: T0 + MIN,
      observedAt: T0 + MIN,
    },
    always,
  );
  await repo.acknowledge(id, user, T0 + MIN);
}

describe("insertAutoTracking", () => {
  it("writes tracking + targets + sources atomically with origin auto and channel_type", async () => {
    const t = await auto(
      ["1", "2"],
      [
        { type: "user", userId: "1" },
        { type: "role", roleId: "700" },
      ],
      { channelType: 5 },
    );
    expect(t.origin).toBe("auto");
    expect(t.channelType).toBe(5);
    expect(t.statusMessageId).toBeNull();
    const targets = await repo.listTargets(t.id);
    expect(targets.map((x) => x.userId)).toEqual(["1", "2"]);
    expect(targets.every((x) => x.addedAt === T0 && x.addedByUserId === "100")).toBe(true);
    expect(await repo.listTrackingSources(t.id)).toEqual([
      { type: "role", roleId: "700" },
      { type: "user", userId: "1" },
    ]);
  });

  it("conflict on an active tracking of the same source returns conflict and writes nothing", async () => {
    const t = await auto(["1"], [{ type: "user", userId: "1" }], { sourceMessageId: "42" });
    const before = await sql`SELECT count(*) AS n FROM tracking_sources`.execute(ctx.db);
    const again = await repo.insertAutoTracking(
      newTracking({ sourceMessageId: "42" }),
      ["3"],
      [{ type: "user", userId: "3" }],
    );
    expect(again).toEqual({ ok: false, reason: "conflict" });
    expect(await sql`SELECT count(*) AS n FROM tracking_sources`.execute(ctx.db)).toEqual(before);
    expect((await repo.listTargets(t.id)).map((x) => x.userId)).toEqual(["1"]);
  });

  it("conflicts with an active manual tracking of the same message", async () => {
    await manual(["1"], { sourceMessageId: "43" });
    const r = await repo.insertAutoTracking(
      newTracking({ sourceMessageId: "43" }),
      ["1"],
      [{ type: "user", userId: "1" }],
    );
    expect(r).toEqual({ ok: false, reason: "conflict" });
  });

  it("permanent auto uniqueness: a second auto tracking after stopAuto → conflict", async () => {
    const t = await auto(["1"], [{ type: "user", userId: "1" }], { sourceMessageId: "44" });
    expect(await repo.stopAuto(t.id, "feature_disabled", T0 + MIN)).toBe(true);
    const r = await repo.insertAutoTracking(
      newTracking({ sourceMessageId: "44" }),
      ["1"],
      [{ type: "user", userId: "1" }],
    );
    expect(r).toEqual({ ok: false, reason: "conflict" });
  });

  it("manual insertTracking after an auto tracking stopped → allowed (active-only index)", async () => {
    const t = await auto(["1"], [{ type: "user", userId: "1" }], { sourceMessageId: "45" });
    await repo.stopAuto(t.id, "no_eligible_targets", T0 + MIN);
    const m = await repo.insertTracking(newTracking({ sourceMessageId: "45" }), ["1"]);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.tracked.origin).toBe("manual");
      expect(m.tracked.channelType).toBeNull();
    }
  });

  it("an empty source list stores no source rows", async () => {
    const t = await auto(["1"], []);
    expect(await repo.listTrackingSources(t.id)).toEqual([]);
  });
});

describe("reconcileAutoTargets", () => {
  it("inactive for a stopped row and for a manual row (manual untouched)", async () => {
    const stopped = await auto(["1"]);
    await repo.stopAuto(stopped.id, "feature_disabled", T0 + MIN);
    expect(await repo.reconcileAutoTargets(stopped.id, ["9"], T0 + 2 * MIN)).toEqual({
      status: "inactive",
    });
    expect((await repo.listTargets(stopped.id)).map((x) => x.userId)).toEqual(["1"]);

    const m = await manual(["1", "2"]);
    await withHistory(m.id, "1");
    const before = await repo.loadView(m.id);
    expect(await repo.reconcileAutoTargets(m.id, ["3"], T0 + 2 * MIN)).toEqual({
      status: "inactive",
    });
    expect(await repo.loadView(m.id)).toEqual(before);
  });

  it("inactive for a missing row", async () => {
    expect(await repo.reconcileAutoTargets(999, ["1"], T0)).toEqual({ status: "inactive" });
  });

  it("adds with added_at=at and added_by '0'; removal deletes target+evidence+ack", async () => {
    const t = await auto(["1", "2"]);
    await withHistory(t.id, "2");
    const r = await repo.reconcileAutoTargets(t.id, ["1", "3"], T0 + 5 * MIN);
    expect(r).toEqual({ status: "changed", added: ["3"], removed: ["2"] });
    const targets = await repo.listTargets(t.id);
    expect(targets).toContainEqual({ userId: "3", addedByUserId: "0", addedAt: T0 + 5 * MIN });
    expect(targets.map((x) => x.userId).sort()).toEqual(["1", "3"]);
    expect((await repo.listEvidence(t.id)).filter((e) => e.userId === "2")).toEqual([]);
    expect(await repo.getAck(t.id, "2")).toBeUndefined();
  });

  it("equal set → unchanged, no writes", async () => {
    const t = await auto(["1", "2"]);
    const before = await repo.loadView(t.id);
    const changes = await sql<{ n: number }>`SELECT total_changes() AS n`.execute(ctx.db);
    expect(await repo.reconcileAutoTargets(t.id, ["2", "1", "2"], T0 + MIN)).toEqual({
      status: "unchanged",
    });
    const after = await sql<{ n: number }>`SELECT total_changes() AS n`.execute(ctx.db);
    expect(after.rows[0]?.n).toBe(changes.rows[0]?.n);
    expect(await repo.loadView(t.id)).toEqual(before);
  });

  it("empty desired → deletes all targets/evidence/acks then stops no_eligible_targets", async () => {
    const t = await auto(["1", "2"]);
    await withHistory(t.id, "1");
    await withHistory(t.id, "2");
    expect(await repo.reconcileAutoTargets(t.id, [], T0 + 3 * MIN)).toEqual({
      status: "stopped",
      removed: ["1", "2"],
    });
    for (const table of ["tracking_targets", "evidence", "acknowledgements"]) {
      expect(await count(table, t.id)).toBe(0);
    }
    const after = await repo.getTracked(t.id);
    expect(after?.stoppedAt).toBe(T0 + 3 * MIN);
    expect(after?.stopReason).toBe("no_eligible_targets");
    expect(after?.stoppedByUserId).toBeNull();
    // never revived
    expect(await repo.reconcileAutoTargets(t.id, ["1"], T0 + 4 * MIN)).toEqual({
      status: "inactive",
    });
  });
});

describe("stopAuto", () => {
  it("keeps rows; no-op on a manual row and on an already stopped row", async () => {
    const t = await auto(["1"]);
    await withHistory(t.id, "1");
    expect(await repo.stopAuto(t.id, "target_limit_exceeded", T0 + MIN)).toBe(true);
    expect(await count("tracking_targets", t.id)).toBe(1);
    expect(await count("evidence", t.id)).toBe(1);
    expect(await count("acknowledgements", t.id)).toBe(1);
    expect((await repo.getTracked(t.id))?.stopReason).toBe("target_limit_exceeded");
    expect(await repo.stopAuto(t.id, "feature_disabled", T0 + 2 * MIN)).toBe(false);

    const m = await manual(["1"]);
    expect(await repo.stopAuto(m.id, "feature_disabled", T0 + MIN)).toBe(false);
    expect((await repo.getTracked(m.id))?.stoppedAt).toBeNull();
  });
});

describe("auto-tracking lookups", () => {
  it("listActiveAutoIdsByMessageRoles: active auto trackings of that guild holding any role", async () => {
    const a = await auto(["1"], [{ type: "role", roleId: "700" }]);
    const b = await auto(["1"], [{ type: "role", roleId: "701" }]);
    await auto(["1"], [{ type: "role", roleId: "702" }]);
    await auto(["1"], [{ type: "role", roleId: "700" }], { guildId: "501" });
    const stopped = await auto(["1"], [{ type: "role", roleId: "700" }]);
    await repo.stopAuto(stopped.id, "feature_disabled", T0);
    await auto(["1"], [{ type: "user", userId: "700" }]); // same ref, different type
    expect((await repo.listActiveAutoIdsByMessageRoles("500", ["700", "701"])).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(await repo.listActiveAutoIdsByMessageRoles("500", [])).toEqual([]);
  });

  it("listActiveAutoIdsWithTarget: active auto trackings where the user is a target", async () => {
    const a = await auto(["1", "2"]);
    await auto(["3"]);
    await manual(["2"]);
    await auto(["2"], [], { guildId: "501" });
    const stopped = await auto(["2"]);
    await repo.stopAuto(stopped.id, "feature_disabled", T0);
    expect(await repo.listActiveAutoIdsWithTarget("500", "2")).toEqual([a.id]);
  });

  it("listActiveAuto filters by guild and channelIds; excludes manual and stopped", async () => {
    const a = await auto(["1"], [], { channelId: "600" });
    const b = await auto(["1"], [], { channelId: "601" });
    const c = await auto(["1"], [], { guildId: "501", channelId: "602" });
    await manual(["1"], { channelId: "600" });
    const stopped = await auto(["1"], [], { channelId: "600" });
    await repo.stopAuto(stopped.id, "feature_disabled", T0);
    const ids = (ts: { id: number }[]) => ts.map((t) => t.id);
    expect(ids(await repo.listActiveAuto({}))).toEqual([a.id, b.id, c.id]);
    expect(ids(await repo.listActiveAuto({ guildId: "500" }))).toEqual([a.id, b.id]);
    expect(ids(await repo.listActiveAuto({ guildId: "500", channelIds: ["601"] }))).toEqual([b.id]);
    expect(await repo.listActiveAuto({ channelIds: [] })).toEqual([]);
  });

  it("activeMessageRoleIds: distinct role sources of active auto trackings in the guild", async () => {
    await auto(["1"], [{ type: "role", roleId: "700" }]);
    await auto(
      ["1"],
      [
        { type: "role", roleId: "700" },
        { type: "role", roleId: "701" },
        { type: "user", userId: "1" },
      ],
    );
    await auto(["1"], [{ type: "role", roleId: "702" }], { guildId: "501" });
    const stopped = await auto(["1"], [{ type: "role", roleId: "703" }]);
    await repo.stopAuto(stopped.id, "feature_disabled", T0);
    expect((await repo.activeMessageRoleIds("500")).sort()).toEqual(["700", "701"]);
  });
});

describe("forgetUser (M9 extension)", () => {
  it("removes tracking_sources user rows and anonymizes policy actor columns in one transaction", async () => {
    const t = await auto(
      ["1", "2"],
      [
        { type: "user", userId: "2" },
        { type: "role", roleId: "2" },
      ],
    );
    await sql`INSERT INTO auto_track_policies
      (guild_id, channel_id, name, state, state_changed_at, state_changed_by,
       created_at, created_by_user_id, updated_at, updated_by_user_id)
      VALUES ('500', '600', 'p', 'enabled', 1, '2', 1, '2', 1, '2')`.execute(ctx.db);
    await sql`INSERT INTO auto_track_policy_sources VALUES (1, 'role', '700', 1, '2')`.execute(
      ctx.db,
    );
    const affected = await repo.forgetUser("2");
    expect(affected).toContain(t.id);
    expect(await repo.listTrackingSources(t.id)).toEqual([{ type: "role", roleId: "2" }]);
    const p = await sql<Record<string, string>>`SELECT * FROM auto_track_policies`.execute(ctx.db);
    expect(p.rows[0]).toMatchObject({
      state_changed_by: "0",
      created_by_user_id: "0",
      updated_by_user_id: "0",
    });
    const s = await sql<Record<string, string>>`
      SELECT added_by_user_id FROM auto_track_policy_sources`.execute(ctx.db);
    expect(s.rows[0]?.added_by_user_id).toBe("0");
  });
});

describe("forgetUser — author exclusion (review finding)", () => {
  it("stops active auto trackings the forgotten user authored, so reconcile can never target them", async () => {
    const own = await auto(["2"], [], { sourceAuthorId: "100", creatorUserId: "100" });
    const others = await auto(["100", "3"], [{ type: "user", userId: "100" }], {
      sourceAuthorId: "7",
      creatorUserId: "7",
    });
    const manual = await repo.insertTracking(newTracking({ sourceAuthorId: "100" }), ["2"]);
    if (!manual.ok) throw new Error();
    await repo.forgetUser("100", T0 + MIN);
    const after = await repo.getTracked(own.id);
    expect(after).toMatchObject({
      stopReason: "manual",
      stoppedByUserId: null,
      stoppedAt: T0 + MIN,
    });
    expect(await repo.reconcileAutoTargets(own.id, ["0", "2"], T0 + 2 * MIN)).toEqual({
      status: "inactive",
    });
    expect((await repo.getTracked(others.id))?.stoppedAt).toBeNull(); // only authored ones stop
    expect((await repo.getTracked(manual.tracked.id))?.stoppedAt).toBeNull(); // manual unchanged
  });

  it("anonymizes tracking_targets.added_by_user_id", async () => {
    await auto(["2"], [], { sourceAuthorId: "100", creatorUserId: "100" });
    await repo.forgetUser("100", T0 + MIN);
    const rows = await sql<{ n: number }>`
      SELECT count(*) AS n FROM tracking_targets WHERE added_by_user_id = '100'`.execute(ctx.db);
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });
});
