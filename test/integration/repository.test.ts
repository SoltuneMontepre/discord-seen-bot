import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Repository } from "../../src/db/repository.ts";
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

async function tracked(targets = ["1", "2"], overrides = {}) {
  const r = await repo.insertTracking(newTracking(overrides), targets);
  if (!r.ok) throw new Error("conflict");
  await repo.setStatusMessageId(r.tracked.id, `9${r.tracked.id}`);
  return r.tracked;
}

describe("migrations and constraints", () => {
  it("creates the expected tables and indexes", async () => {
    const rows = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'
    `.execute(ctx.db);
    const names = rows.rows.map((r) => r.name);
    for (const n of [
      "tracked_messages",
      "tracking_targets",
      "evidence",
      "acknowledgements",
      "bot_state",
      "ux_tracked_active_source",
      "ix_tracked_active_channel",
      "ix_evidence_reply_msg",
    ])
      expect(names).toContain(n);
  });

  it.each([
    ["reaction with occurred_at", "DIRECT_REACTION", "👍|0", 1],
    ["reply without occurred_at", "DIRECT_REPLY", "777", null],
    ["weak row with a key", "TYPING_AFTER", "x", 1],
    ["unknown kind", "SEEN", "", 1],
  ])("CHECK rejects %s", async (_n, kind, key, occurred) => {
    const t = await tracked();
    await expect(
      sql`INSERT INTO evidence VALUES (${t.id}, '1', ${kind}, ${key}, ${occurred}, 1)`.execute(
        ctx.db,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("tracked messages", () => {
  it("allows only one active tracking per source, and re-tracking after stop", async () => {
    const t = await tracked(["1"], { sourceMessageId: "42" });
    expect(await repo.insertTracking(newTracking({ sourceMessageId: "42" }), ["1"])).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(await repo.stopTracking(t.id, "manual", T0 + MIN, "100")).toBe(true);
    expect(await repo.stopTracking(t.id, "manual", T0 + MIN, "100")).toBe(false);
    const again = await repo.insertTracking(newTracking({ sourceMessageId: "42" }), ["1"]);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.tracked.id).toBeGreaterThan(t.id);
  });

  it("never reuses ids after deletion (AUTOINCREMENT)", async () => {
    const a = await tracked();
    await repo.deleteTracking(a.id);
    const b = await tracked();
    expect(b.id).toBeGreaterThan(a.id);
  });

  it("purge cascades to targets, evidence and acks", async () => {
    const t = await tracked(["1"]);
    await repo.recordEvidence(
      {
        trackedMessageId: t.id,
        userId: "1",
        kind: "DIRECT_REPLY",
        sourceKey: "77",
        occurredAt: T0,
        observedAt: T0,
      },
      always,
    );
    await repo.acknowledge(t.id, "1", T0);
    await repo.stopTracking(t.id, "expired", T0);
    expect(await repo.purgeStoppedBefore(T0 - 1)).toBe(0);
    expect(await repo.purgeStoppedBefore(T0)).toBe(1);
    const counts = await sql<{ n: number }>`
      SELECT (SELECT count(*) FROM tracking_targets) + (SELECT count(*) FROM evidence)
           + (SELECT count(*) FROM acknowledgements) AS n`.execute(ctx.db);
    expect(counts.rows[0]?.n).toBe(0);
  });

  it("deleteUnfinishedStarts removes only active rows without a companion", async () => {
    const done = await tracked();
    const r = await repo.insertTracking(newTracking(), ["1"]);
    expect(r.ok).toBe(true);
    expect(await repo.deleteUnfinishedStarts()).toBe(1);
    expect(await repo.getTracked(done.id)).toBeDefined();
  });
});

describe("evidence writes", () => {
  it("weak evidence is earliest-wins and replays report unchanged", async () => {
    const t = await tracked(["1"]);
    const base = { trackedMessageId: t.id, userId: "1", kind: "TYPING_AFTER" as const };
    expect(
      await repo.recordEvidence({ ...base, occurredAt: T0 + 5 * MIN, observedAt: 1 }, always),
    ).toBe("changed");
    expect(
      await repo.recordEvidence({ ...base, occurredAt: T0 + 5 * MIN, observedAt: 2 }, always),
    ).toBe("unchanged");
    expect(
      await repo.recordEvidence({ ...base, occurredAt: T0 + 9 * MIN, observedAt: 3 }, always),
    ).toBe("unchanged");
    expect(
      await repo.recordEvidence({ ...base, occurredAt: T0 + 1 * MIN, observedAt: 4 }, always),
    ).toBe("changed");
    const ev = await repo.listEvidence(t.id);
    expect(ev).toEqual([{ ...base, sourceKey: "", occurredAt: T0 + MIN, observedAt: 4 }]);
  });

  it("replies are keyed per reply message; duplicates are ignored", async () => {
    const t = await tracked(["1"]);
    const reply = (id: string) => ({
      trackedMessageId: t.id,
      userId: "1",
      kind: "DIRECT_REPLY" as const,
      sourceKey: id,
      occurredAt: T0,
      observedAt: T0,
    });
    expect(await repo.recordEvidence(reply("a"), always)).toBe("changed");
    expect(await repo.recordEvidence(reply("a"), always)).toBe("unchanged");
    expect(await repo.recordEvidence(reply("b"), always)).toBe("changed");
    expect(await repo.listEvidence(t.id)).toHaveLength(2);
  });

  it("rejects non-targets and invalid evidence without writing", async () => {
    const t = await tracked(["1"]);
    const e = {
      trackedMessageId: t.id,
      userId: "3",
      kind: "TYPING_AFTER" as const,
      occurredAt: T0,
      observedAt: T0,
    };
    expect(await repo.recordEvidence(e, always)).toBe("not_target");
    expect(await repo.recordEvidence({ ...e, userId: "1" }, () => false)).toBe("invalid");
    expect(await repo.listEvidence(t.id)).toEqual([]);
  });

  it("deleteRepliesByMessageIds returns affected tracked ids and is idempotent", async () => {
    const t1 = await tracked(["1"]);
    const t2 = await tracked(["1"]);
    for (const [tid, key] of [
      [t1.id, "r1"],
      [t1.id, "r2"],
      [t2.id, "r3"],
    ] as const) {
      await repo.recordEvidence(
        {
          trackedMessageId: tid,
          userId: "1",
          kind: "DIRECT_REPLY",
          sourceKey: key,
          occurredAt: T0,
          observedAt: T0,
        },
        always,
      );
    }
    expect(await repo.deleteRepliesByMessageIds(["r1", "r3", "zzz"])).toEqual([t1.id, t2.id]);
    expect(await repo.deleteRepliesByMessageIds(["r1", "r3"])).toEqual([]);
    expect((await repo.listEvidence(t1.id)).map((e) => e.sourceKey)).toEqual(["r2"]);
  });

  it("reaction deletes are precise per key", async () => {
    const t = await tracked(["1", "2"]);
    for (const [user, key] of [
      ["1", "👍|0"],
      ["1", "👍|1"],
      ["2", "🎉|0"],
    ] as const) {
      await repo.recordEvidence(
        {
          trackedMessageId: t.id,
          userId: user,
          kind: "DIRECT_REACTION",
          sourceKey: key,
          occurredAt: null,
          observedAt: T0,
        },
        always,
      );
    }
    expect(await repo.deleteEvidence(t.id, "1", "DIRECT_REACTION", "👍|0")).toBe(true);
    expect(await repo.deleteReactionsByKeys(t.id, ["👍|0", "👍|1"])).toBe(true);
    expect((await repo.listEvidence(t.id)).map((e) => e.sourceKey)).toEqual(["🎉|0"]);
    expect(await repo.deleteAllReactions(t.id)).toBe(true);
    expect(await repo.deleteAllReactions(t.id)).toBe(false);
  });
});

describe("targets and acks", () => {
  it("replaceTargets deletes removed users' evidence and ack; new users get addedAt", async () => {
    const t = await tracked(["1", "2"]);
    await repo.recordEvidence(
      { trackedMessageId: t.id, userId: "2", kind: "TYPING_AFTER", occurredAt: T0, observedAt: T0 },
      always,
    );
    await repo.acknowledge(t.id, "2", T0);
    const diff = await repo.replaceTargets(t.id, ["1", "3"], "100", T0 + 30 * MIN);
    expect(diff).toEqual({ added: ["3"], removed: ["2"] });
    expect(await repo.listEvidence(t.id)).toEqual([]);
    expect(await repo.listAcks(t.id)).toEqual([]);
    expect(await repo.getTarget(t.id, "3")).toMatchObject({
      addedAt: T0 + 30 * MIN,
      addedByUserId: "100",
    });
  });

  it("acknowledge is target-checked, idempotent, and re-armable after revoke", async () => {
    const t = await tracked(["1"]);
    expect(await repo.acknowledge(t.id, "9", T0)).toEqual({ result: "not_target" });
    expect(await repo.acknowledge(t.id, "1", T0)).toEqual({ result: "acknowledged" });
    expect(await repo.acknowledge(t.id, "1", T0 + MIN)).toEqual({
      result: "already",
      ack: { userId: "1", acknowledgedAt: T0, revokedAt: null },
    });
    expect(await repo.revokeAck(t.id, "1", T0 + 2 * MIN)).toBe(true);
    expect(await repo.revokeAck(t.id, "1", T0 + 3 * MIN)).toBe(false);
    expect(await repo.acknowledge(t.id, "1", T0 + 4 * MIN)).toEqual({ result: "acknowledged" });
    expect(await repo.getAck(t.id, "1")).toEqual({
      userId: "1",
      acknowledgedAt: T0 + 4 * MIN,
      revokedAt: null,
    });
  });
});

describe("pageActiveReplies", () => {
  it("keyset-pages all rows of active tracking, stable while rows are deleted", async () => {
    const a = await tracked(["1", "2"]);
    const b = await tracked(["1"]);
    const stopped = await tracked(["1"]);
    const keys: [number, string, string][] = [];
    for (let i = 0; i < 7; i++) keys.push([a.id, i % 2 ? "1" : "2", `a${i}`]);
    for (let i = 0; i < 5; i++) keys.push([b.id, "1", `b${i}`]);
    keys.push([stopped.id, "1", "s0"]);
    for (const [tid, user, key] of keys) {
      await repo.recordEvidence(
        {
          trackedMessageId: tid,
          userId: user,
          kind: "DIRECT_REPLY",
          sourceKey: key,
          occurredAt: T0,
          observedAt: T0,
        },
        always,
      );
    }
    await repo.stopTracking(stopped.id, "manual", T0);

    const seen: string[] = [];
    let cursor = null;
    for (;;) {
      const page = await repo.pageActiveReplies(cursor, 3);
      for (const row of page) {
        seen.push(row.sourceKey);
        await repo.deleteRepliesByMessageIds([row.sourceKey]); // deletion mid-iteration
      }
      if (page.length < 3) break;
      cursor = page[page.length - 1] ?? null;
    }
    expect(seen.sort()).toEqual([...keys.slice(0, 12).map((k) => k[2])].sort());
  });
});

describe("bot_state watermark", () => {
  it("round-trips and overwrites", async () => {
    expect(await repo.getWatermark()).toBeNull();
    await repo.setWatermark(T0);
    await repo.setWatermark(T0 + MIN);
    expect(await repo.getWatermark()).toBe(T0 + MIN);
  });
});

describe("forgetUser", () => {
  it("removes the user's rows and anonymizes references", async () => {
    const t = await tracked(["1", "2"], { creatorUserId: "1" });
    await repo.acknowledge(t.id, "1", T0);
    expect(await repo.forgetUser("1")).toEqual([t.id]);
    expect((await repo.listTargets(t.id)).map((x) => x.userId)).toEqual(["2"]);
    expect(await repo.listAcks(t.id)).toEqual([]);
    expect((await repo.getTracked(t.id))?.creatorUserId).toBe("0");
  });
});
