import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

const statements = [
  `CREATE TABLE tracked_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,      -- AUTOINCREMENT: ids are never reused (custom_id safety)
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,                  -- thread id when tracked inside a thread/forum post
    parent_channel_id TEXT,
    source_message_id TEXT NOT NULL,
    source_author_id TEXT NOT NULL,
    source_created_at INTEGER NOT NULL,
    status_message_id TEXT,                    -- NULL only while a start is in flight
    creator_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    weak_window_ends_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    initial_backfill_at INTEGER,
    stopped_at INTEGER,
    stop_reason TEXT CHECK (stop_reason IN
      ('manual','expired','source_deleted','status_deleted','channel_deleted')),
    stopped_by_user_id TEXT,
    rendered_hash TEXT,
    CHECK ((stopped_at IS NULL) = (stop_reason IS NULL))
  )`,
  "CREATE UNIQUE INDEX ux_tracked_active_source ON tracked_messages(source_message_id) WHERE stopped_at IS NULL",
  "CREATE INDEX ix_tracked_active_channel ON tracked_messages(channel_id, weak_window_ends_at) WHERE stopped_at IS NULL",
  "CREATE INDEX ix_tracked_parent ON tracked_messages(parent_channel_id) WHERE stopped_at IS NULL",
  "CREATE INDEX ix_tracked_status ON tracked_messages(status_message_id)",
  "CREATE INDEX ix_tracked_expires ON tracked_messages(expires_at) WHERE stopped_at IS NULL",
  "CREATE INDEX ix_tracked_stopped ON tracked_messages(stopped_at)",
  "CREATE INDEX ix_tracked_guild ON tracked_messages(guild_id)",
  `CREATE TABLE tracking_targets (
    tracked_message_id INTEGER NOT NULL REFERENCES tracked_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    added_by_user_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,                 -- lower bound for this target's weak evidence
    PRIMARY KEY (tracked_message_id, user_id)
  ) WITHOUT ROWID`,
  "CREATE INDEX ix_targets_user ON tracking_targets(user_id)",
  `CREATE TABLE evidence (
    tracked_message_id INTEGER NOT NULL REFERENCES tracked_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN
      ('DIRECT_REPLY','DIRECT_REACTION','CHANNEL_MESSAGE_AFTER','TYPING_AFTER')),
    source_key TEXT NOT NULL,                  -- reply msg id | "<emoji>|<type>" | ''
    occurred_at INTEGER,                       -- Discord event time; NULL iff DIRECT_REACTION
    observed_at INTEGER NOT NULL,              -- when the bot recorded it
    PRIMARY KEY (tracked_message_id, user_id, kind, source_key),
    CHECK ((kind = 'DIRECT_REACTION') = (occurred_at IS NULL)),
    CHECK ((kind IN ('CHANNEL_MESSAGE_AFTER','TYPING_AFTER')) = (source_key = ''))
  ) WITHOUT ROWID`,
  "CREATE INDEX ix_evidence_reply_msg ON evidence(source_key) WHERE kind = 'DIRECT_REPLY'",
  "CREATE INDEX ix_evidence_user ON evidence(user_id)",
  `CREATE TABLE acknowledgements (
    tracked_message_id INTEGER NOT NULL REFERENCES tracked_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    acknowledged_at INTEGER NOT NULL,
    revoked_at INTEGER,
    PRIMARY KEY (tracked_message_id, user_id)
  ) WITHOUT ROWID`,
  "CREATE INDEX ix_acks_user ON acknowledgements(user_id)",
  // key 'last_gateway_healthy_at': recovery watermark for MESSAGE-DERIVED evidence only (see gateway-health.ts)
  "CREATE TABLE bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
];

export const m0001_initial: Migration = {
  async up(db: Kysely<unknown>) {
    for (const statement of statements) await sql.raw(statement).execute(db);
  },
};
