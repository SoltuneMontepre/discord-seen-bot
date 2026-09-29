import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * M9: origin + channel_type + three stop reasons on tracked_messages (CHECK change ⇒ 12-step rebuild),
 * tracking_sources, and the channel auto-track policy tables.
 *
 * Kysely's SQLite adapter reports supportsTransactionalDdl = false, so the migrator does NOT wrap
 * migrations in a transaction. This migration therefore opens its own transaction around every
 * statement, including the final foreign_key_check: any failure rolls the whole migration back.
 * migrateToLatest() turns foreign keys OFF before the migrator (outside any transaction, where the
 * pragma takes effect) so DROP TABLE does not cascade into children.
 *
 * Re-entry guard: if the process dies after this transaction commits but before Kysely records the
 * migration row, the next start sees an already-migrated schema and does nothing (Kysely then records it).
 */
const TRACKED_COLUMNS = `id, guild_id, channel_id, parent_channel_id, source_message_id, source_author_id,
  source_created_at, status_message_id, creator_user_id, created_at, weak_window_ends_at, expires_at,
  initial_backfill_at, stopped_at, stop_reason, stopped_by_user_id, rendered_hash`;

const statements = [
  `CREATE TABLE tracked_messages_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    parent_channel_id TEXT,
    source_message_id TEXT NOT NULL,
    source_author_id TEXT NOT NULL,
    source_created_at INTEGER NOT NULL,
    status_message_id TEXT,
    creator_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    weak_window_ends_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    initial_backfill_at INTEGER,
    stopped_at INTEGER,
    stop_reason TEXT CHECK (stop_reason IN
      ('manual','expired','source_deleted','status_deleted','channel_deleted',
       'no_eligible_targets','feature_disabled','target_limit_exceeded')),
    stopped_by_user_id TEXT,
    rendered_hash TEXT,
    origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','auto')),
    channel_type INTEGER,                      -- Discord channel type of an auto tracking's location (D4); NULL for manual/legacy
    CHECK ((stopped_at IS NULL) = (stop_reason IS NULL))
  )`,
  `INSERT INTO tracked_messages_new (${TRACKED_COLUMNS}, origin)
     SELECT ${TRACKED_COLUMNS}, 'manual' FROM tracked_messages`,
  "DROP TABLE tracked_messages",
  "ALTER TABLE tracked_messages_new RENAME TO tracked_messages",
  // the 7 existing indexes, same names
  "CREATE UNIQUE INDEX ux_tracked_active_source ON tracked_messages(source_message_id) WHERE stopped_at IS NULL",
  "CREATE INDEX ix_tracked_active_channel ON tracked_messages(channel_id, weak_window_ends_at) WHERE stopped_at IS NULL",
  "CREATE INDEX ix_tracked_parent ON tracked_messages(parent_channel_id) WHERE stopped_at IS NULL",
  "CREATE INDEX ix_tracked_status ON tracked_messages(status_message_id)",
  "CREATE INDEX ix_tracked_expires ON tracked_messages(expires_at) WHERE stopped_at IS NULL",
  "CREATE INDEX ix_tracked_stopped ON tracked_messages(stopped_at)",
  "CREATE INDEX ix_tracked_guild ON tracked_messages(guild_id)",
  // new tracked_messages indexes
  "CREATE INDEX ix_tracked_active_auto ON tracked_messages(guild_id, channel_id) WHERE stopped_at IS NULL AND origin = 'auto'",
  "CREATE UNIQUE INDEX ux_tracked_auto_source ON tracked_messages(source_message_id) WHERE origin = 'auto'",
  // message-derived Target Sources (frozen at MESSAGE_CREATE, spec §7.2)
  `CREATE TABLE tracking_sources (
    tracked_message_id INTEGER NOT NULL REFERENCES tracked_messages(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,                 -- 'user' | 'role' (open set; validated in app)
    source_ref TEXT NOT NULL,                  -- snowflake
    PRIMARY KEY (tracked_message_id, source_type, source_ref)
  ) WITHOUT ROWID`,
  "CREATE INDEX ix_tracking_sources_ref ON tracking_sources(source_type, source_ref)",
  // channel auto-track policies (spec §7.3)
  `CREATE TABLE auto_track_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,      -- stable id, never reused (custom_id safety)
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    state TEXT NOT NULL DEFAULT 'enabled'
      CHECK (state IN ('enabled','user_disabled','auto_disabled_missing_role')),
    state_changed_at INTEGER NOT NULL,
    state_changed_by TEXT NOT NULL,            -- '0' = system
    created_at INTEGER NOT NULL,
    created_by_user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by_user_id TEXT NOT NULL
  )`,
  `CREATE TABLE auto_track_policy_sources (
    policy_id INTEGER NOT NULL REFERENCES auto_track_policies(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,                 -- 'role' in M9 (same vocabulary as tracking_sources)
    source_ref TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    added_by_user_id TEXT NOT NULL,
    PRIMARY KEY (policy_id, source_type, source_ref)
  ) WITHOUT ROWID`,
  "CREATE INDEX ix_policies_channel_enabled ON auto_track_policies(channel_id) WHERE state = 'enabled'",
  "CREATE INDEX ix_policies_guild ON auto_track_policies(guild_id)",
  "CREATE INDEX ix_policy_sources_ref ON auto_track_policy_sources(source_type, source_ref)",
];

async function alreadyApplied(db: Kysely<unknown>): Promise<boolean> {
  const cols = await sql<{ name: string }>`PRAGMA table_info(tracked_messages)`.execute(db);
  const table = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tracking_sources'`.execute(db);
  return cols.rows.some((c) => c.name === "origin") && table.rows.length > 0;
}

async function apply(db: Kysely<unknown>): Promise<void> {
  const seqRow = await sql<{ seq: number }>`
      SELECT seq FROM sqlite_sequence WHERE name = 'tracked_messages'`.execute(db);
  const oldSeq = Number(seqRow.rows[0]?.seq ?? 0);

  for (const statement of statements) await sql.raw(statement).execute(db);

  // Preserve the AUTOINCREMENT high-water mark so ids of purged rows are never reused.
  const maxRow = await sql<{ m: number | null }>`SELECT MAX(id) AS m FROM tracked_messages`.execute(
    db,
  );
  const seq = Math.max(oldSeq, Number(maxRow.rows[0]?.m ?? 0));
  await sql`DELETE FROM sqlite_sequence WHERE name IN ('tracked_messages', 'tracked_messages_new')`.execute(
    db,
  );
  if (seq > 0) {
    await sql`INSERT INTO sqlite_sequence (name, seq) VALUES ('tracked_messages', ${seq})`.execute(
      db,
    );
  }

  const violations = await sql`PRAGMA foreign_key_check`.execute(db);
  if (violations.rows.length > 0) {
    throw new Error(
      `foreign key check failed inside migration 0002 (${violations.rows.length} violation(s)); rolled back`,
    );
  }
}

export const m0002_auto_track: Migration = {
  async up(db: Kysely<unknown>) {
    if (await alreadyApplied(db)) return;
    if (db.isTransaction) await apply(db);
    else await db.transaction().execute((trx) => apply(trx));
  },
};
