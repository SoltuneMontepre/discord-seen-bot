import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DatabaseHandle, openDatabase } from "../../src/db/database.ts";
import { migrateTo, migrateToLatest } from "../../src/db/migrator.ts";
import { Repository } from "../../src/db/repository.ts";
import { decodeCustomId } from "../../src/discord/custom-id.ts";
import { newTracking } from "../helpers/db.ts";
import { T0 } from "../helpers/domain.ts";
import { tempDbPath } from "../helpers/tmp.ts";

let tmp: ReturnType<typeof tempDbPath>;
let h: DatabaseHandle;

beforeEach(() => {
  tmp = tempDbPath("mig0002");
  h = openDatabase(tmp.path);
});
afterEach(async () => {
  await h.close();
  tmp.cleanup();
});

const COLS = `id, guild_id, channel_id, parent_channel_id, source_message_id, source_author_id,
  source_created_at, status_message_id, creator_user_id, created_at, weak_window_ends_at, expires_at,
  initial_backfill_at, stopped_at, stop_reason, stopped_by_user_id, rendered_hash`;

async function insertV1(id: number, opts: { stopped?: boolean } = {}) {
  await sql`INSERT INTO tracked_messages (id, guild_id, channel_id, parent_channel_id, source_message_id,
      source_author_id, source_created_at, status_message_id, creator_user_id, created_at,
      weak_window_ends_at, expires_at, initial_backfill_at, stopped_at, stop_reason, stopped_by_user_id,
      rendered_hash)
    VALUES (${id}, '500', '600', NULL, ${`src${id}`}, '100', ${T0 - 1000}, ${`st${id}`}, '100', ${T0},
      ${T0 + 7_200_000}, ${T0 + 604_800_000}, ${T0 + 5}, ${opts.stopped ? T0 + 9 : null},
      ${opts.stopped ? "manual" : null}, ${opts.stopped ? "100" : null}, ${`hash${id}`})`.execute(
    h.db,
  );
}

async function rows(query: string) {
  return (await sql.raw(query).execute(h.db)).rows as Record<string, unknown>[];
}

async function count(table: string) {
  const r = await rows(`SELECT count(*) AS n FROM ${table}`);
  return Number(r[0]?.n);
}

describe("migration 0002_auto_track", () => {
  it("migrates a 0001 database with data: rows, ids, columns and children survive; origin='manual'", async () => {
    await migrateTo(h.db, "0001_initial");
    await insertV1(1, { stopped: true });
    await insertV1(2);
    await insertV1(3);
    await sql`INSERT INTO tracking_targets VALUES (2, '11', '100', ${T0}), (2, '12', '100', ${T0})`.execute(
      h.db,
    );
    await sql`INSERT INTO evidence VALUES (2, '11', 'DIRECT_REPLY', 'r1', ${T0 + 1}, ${T0 + 2}),
      (2, '12', 'DIRECT_REACTION', '👍|0', NULL, ${T0 + 3})`.execute(h.db);
    await sql`INSERT INTO acknowledgements VALUES (2, '11', ${T0 + 4}, NULL)`.execute(h.db);
    const before = await rows(`SELECT ${COLS} FROM tracked_messages ORDER BY id`);

    const applied = await migrateToLatest(h.db);
    expect(applied).toEqual(["0002_auto_track"]);

    const after = await rows(`SELECT ${COLS} FROM tracked_messages ORDER BY id`);
    expect(after).toEqual(before);
    const extra = await rows("SELECT id, origin, channel_type FROM tracked_messages ORDER BY id");
    expect(extra).toEqual([
      { id: 1, origin: "manual", channel_type: null },
      { id: 2, origin: "manual", channel_type: null },
      { id: 3, origin: "manual", channel_type: null },
    ]);
    expect(await count("tracking_targets")).toBe(2);
    expect(await count("evidence")).toBe(2);
    expect(await count("acknowledgements")).toBe(1);
  });

  it("foreign keys enforced after migration and foreign_key_check is clean", async () => {
    await migrateToLatest(h.db);
    expect((await rows("PRAGMA foreign_keys"))[0]).toEqual({ foreign_keys: 1 });
    expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
    await expect(
      sql`INSERT INTO evidence VALUES (999, '1', 'TYPING_AFTER', '', 1, 1)`.execute(h.db),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("cascade still works on the rebuilt parent", async () => {
    await migrateTo(h.db, "0001_initial");
    await insertV1(1);
    await sql`INSERT INTO tracking_targets VALUES (1, '11', '100', ${T0})`.execute(h.db);
    await migrateToLatest(h.db);
    await sql`DELETE FROM tracked_messages WHERE id = 1`.execute(h.db);
    expect(await count("tracking_targets")).toBe(0);
  });

  it("sequence preserved when highest ids were purged: stale sb1 ids cannot address a new tracking", async () => {
    await migrateTo(h.db, "0001_initial");
    for (let i = 1; i <= 5; i++) await insertV1(i);
    await sql`DELETE FROM tracked_messages WHERE id IN (4, 5)`.execute(h.db);
    await migrateToLatest(h.db);
    const repo = new Repository(h.db);
    const r = await repo.insertTracking(newTracking(), ["1"]);
    expect(r.ok && r.tracked.id).toBe(6);
    const stale = decodeCustomId("sb1:ack:4");
    expect(stale).toEqual({ action: "ack", trackedId: 4 });
    expect(await repo.getTracked(4)).toBeUndefined();
  });

  it("re-running migrateToLatest is a no-op", async () => {
    await migrateToLatest(h.db);
    await migrateTo(h.db, "0002_auto_track");
    expect(await migrateToLatest(h.db)).toEqual([]);
  });

  it("re-entry after commit-without-record is safe (crash window between commit and kysely_migration row)", async () => {
    await migrateTo(h.db, "0001_initial");
    await insertV1(1);
    await migrateToLatest(h.db);
    await sql`DELETE FROM kysely_migration WHERE name = '0002_auto_track'`.execute(h.db);
    const before = await rows("SELECT * FROM tracked_messages ORDER BY id");
    expect(await migrateToLatest(h.db)).toEqual(["0002_auto_track"]);
    expect(await rows("SELECT * FROM tracked_messages ORDER BY id")).toEqual(before);
  });

  it("violating FK check rolls back 0002 entirely", async () => {
    await migrateTo(h.db, "0001_initial");
    await insertV1(1);
    await sql`PRAGMA foreign_keys = OFF`.execute(h.db);
    await sql`INSERT INTO evidence VALUES (777, '1', 'TYPING_AFTER', '', 1, 1)`.execute(h.db);
    await expect(migrateToLatest(h.db)).rejects.toThrow(/foreign key/i);
    const applied = await rows("SELECT name FROM kysely_migration ORDER BY name");
    expect(applied).toEqual([{ name: "0001_initial" }]);
    const cols = (await rows("PRAGMA table_info(tracked_messages)")).map((c) => c.name);
    expect(cols).not.toContain("origin");
    expect(await rows("SELECT name FROM sqlite_master WHERE name = 'tracking_sources'")).toEqual(
      [],
    );
    expect((await rows("PRAGMA foreign_keys"))[0]).toEqual({ foreign_keys: 1 });
  });

  it("CHECK constraints: origin, 8 stop reasons, policy state", async () => {
    await migrateToLatest(h.db);
    const ins = (id: number, origin: string, stopped: string | null) =>
      sql`INSERT INTO tracked_messages (id, guild_id, channel_id, source_message_id, source_author_id,
          source_created_at, creator_user_id, created_at, weak_window_ends_at, expires_at, origin,
          stopped_at, stop_reason)
        VALUES (${id}, 'g', 'c', ${`m${id}`}, 'a', 1, 'a', 1, 1, 1, ${origin}, ${stopped ? 1 : null}, ${stopped})`.execute(
        h.db,
      );
    await expect(ins(1, "other", null)).rejects.toThrow(/CHECK/);
    const reasons = [
      "manual",
      "expired",
      "source_deleted",
      "status_deleted",
      "channel_deleted",
      "no_eligible_targets",
      "feature_disabled",
      "target_limit_exceeded",
    ];
    for (const [i, r] of reasons.entries()) await ins(10 + i, "auto", r);
    await expect(ins(99, "manual", "bogus")).rejects.toThrow(/CHECK/);
    await expect(
      sql`INSERT INTO auto_track_policies (guild_id, channel_id, name, state, state_changed_at,
          state_changed_by, created_at, created_by_user_id, updated_at, updated_by_user_id)
        VALUES ('g', 'c', 'n', 'bogus', 1, 'u', 1, 'u', 1, 'u')`.execute(h.db),
    ).rejects.toThrow(/CHECK/);
  });

  it("exact index set (17 names)", async () => {
    await migrateToLatest(h.db);
    const names = (
      await rows("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
    )
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(
      [
        "ux_tracked_active_source",
        "ix_tracked_active_channel",
        "ix_tracked_parent",
        "ix_tracked_status",
        "ix_tracked_expires",
        "ix_tracked_stopped",
        "ix_tracked_guild",
        "ix_targets_user",
        "ix_evidence_reply_msg",
        "ix_evidence_user",
        "ix_acks_user",
        "ix_tracked_active_auto",
        "ux_tracked_auto_source",
        "ix_tracking_sources_ref",
        "ix_policies_channel_enabled",
        "ix_policies_guild",
        "ix_policy_sources_ref",
      ].sort(),
    );
    const sqlOf = async (n: string) =>
      String((await rows(`SELECT sql FROM sqlite_master WHERE name='${n}'`))[0]?.sql);
    expect(await sqlOf("ix_tracked_active_auto")).toMatch(/origin\s*=\s*'auto'/);
    expect(await sqlOf("ux_tracked_auto_source")).toMatch(/origin\s*=\s*'auto'/);
    expect(await sqlOf("ix_policies_channel_enabled")).toMatch(/state\s*=\s*'enabled'/);
  });

  it("existing rows have channel_type NULL; tracking_sources cascade with the tracking", async () => {
    await migrateTo(h.db, "0001_initial");
    await insertV1(1);
    await migrateToLatest(h.db);
    expect(await rows("SELECT channel_type FROM tracked_messages")).toEqual([
      { channel_type: null },
    ]);
    await sql`INSERT INTO tracking_sources VALUES (1, 'user', '11'), (1, 'role', '22')`.execute(
      h.db,
    );
    await sql`DELETE FROM tracked_messages WHERE id = 1`.execute(h.db);
    expect(await count("tracking_sources")).toBe(0);
  });
});
