import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import type {
  Ack,
  Evidence,
  EvidenceKind,
  Snowflake,
  StopReason,
  Target,
  TrackedMessage,
  UnixMs,
} from "../domain/types.ts";
import type { Database, TrackedMessagesTable } from "./schema.ts";

type Db = Kysely<Database> | Transaction<Database>;

export interface NewTracking {
  guildId: Snowflake;
  channelId: Snowflake;
  parentChannelId: Snowflake | null;
  sourceMessageId: Snowflake;
  sourceAuthorId: Snowflake;
  sourceCreatedAt: UnixMs;
  creatorUserId: Snowflake;
  createdAt: UnixMs;
  weakWindowEndsAt: UnixMs;
  expiresAt: UnixMs;
}

export interface TrackingView {
  tracked: TrackedMessage;
  targets: Target[];
  evidence: Evidence[];
  acks: Ack[];
}

export type EvidenceWriteResult = "changed" | "unchanged" | "not_target" | "invalid";

export interface ReplyCursor {
  trackedMessageId: number;
  userId: string;
  sourceKey: string;
}

export interface ActiveReplyRow extends ReplyCursor {
  channelId: Snowflake;
}

const WATERMARK_KEY = "last_gateway_healthy_at";

function toTracked(r: Selectable<TrackedMessagesTable>): TrackedMessage {
  return {
    id: r.id,
    guildId: r.guild_id,
    channelId: r.channel_id,
    parentChannelId: r.parent_channel_id,
    sourceMessageId: r.source_message_id,
    sourceAuthorId: r.source_author_id,
    sourceCreatedAt: r.source_created_at,
    statusMessageId: r.status_message_id,
    creatorUserId: r.creator_user_id,
    createdAt: r.created_at,
    weakWindowEndsAt: r.weak_window_ends_at,
    expiresAt: r.expires_at,
    initialBackfillAt: r.initial_backfill_at,
    stoppedAt: r.stopped_at,
    stopReason: r.stop_reason,
    stoppedByUserId: r.stopped_by_user_id,
    renderedHash: r.rendered_hash,
    origin: r.origin,
    channelType: r.channel_type,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

const changed = (n: bigint | undefined) => (n ?? 0n) > 0n;

export class Repository {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  // ---------------------------------------------------------------- tracked_messages

  /** Inserts a tracked message and its initial targets atomically (targets.addedAt = createdAt). */
  async insertTracking(
    input: NewTracking,
    targetIds: readonly Snowflake[],
  ): Promise<{ ok: true; tracked: TrackedMessage } | { ok: false; reason: "conflict" }> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto("tracked_messages")
          .values({
            guild_id: input.guildId,
            channel_id: input.channelId,
            parent_channel_id: input.parentChannelId,
            source_message_id: input.sourceMessageId,
            source_author_id: input.sourceAuthorId,
            source_created_at: input.sourceCreatedAt,
            creator_user_id: input.creatorUserId,
            created_at: input.createdAt,
            weak_window_ends_at: input.weakWindowEndsAt,
            expires_at: input.expiresAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (targetIds.length > 0) {
          await trx
            .insertInto("tracking_targets")
            .values(
              targetIds.map((userId) => ({
                tracked_message_id: row.id,
                user_id: userId,
                added_by_user_id: input.creatorUserId,
                added_at: input.createdAt,
              })),
            )
            .execute();
        }
        return { ok: true as const, tracked: toTracked(row) };
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: "conflict" };
      throw err;
    }
  }

  async setStatusMessageId(id: number, statusMessageId: Snowflake): Promise<void> {
    await this.db
      .updateTable("tracked_messages")
      .set({ status_message_id: statusMessageId })
      .where("id", "=", id)
      .execute();
  }

  /** Hard delete (rollback of a failed start). Cascades to targets/evidence/acks. */
  async deleteTracking(id: number): Promise<void> {
    await this.db.deleteFrom("tracked_messages").where("id", "=", id).execute();
  }

  async getTracked(id: number): Promise<TrackedMessage | undefined> {
    const r = await this.db
      .selectFrom("tracked_messages")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return r && toTracked(r);
  }

  async findActiveBySource(sourceMessageId: Snowflake): Promise<TrackedMessage | undefined> {
    const r = await this.db
      .selectFrom("tracked_messages")
      .selectAll()
      .where("source_message_id", "=", sourceMessageId)
      .where("stopped_at", "is", null)
      .executeTakeFirst();
    return r && toTracked(r);
  }

  async findActiveByStatusMessage(statusMessageId: Snowflake): Promise<TrackedMessage[]> {
    const rows = await this.db
      .selectFrom("tracked_messages")
      .selectAll()
      .where("status_message_id", "=", statusMessageId)
      .where("stopped_at", "is", null)
      .execute();
    return rows.map(toTracked);
  }

  async listActive(): Promise<TrackedMessage[]> {
    const rows = await this.db
      .selectFrom("tracked_messages")
      .selectAll()
      .where("stopped_at", "is", null)
      .orderBy("id")
      .execute();
    return rows.map(toTracked);
  }

  /** Active tracked messages in a channel whose weak window has not ended before `occurredAt`. */
  async listActiveInWeakWindow(
    channelId: Snowflake,
    occurredAt: UnixMs,
  ): Promise<TrackedMessage[]> {
    const rows = await this.db
      .selectFrom("tracked_messages")
      .selectAll()
      .where("channel_id", "=", channelId)
      .where("stopped_at", "is", null)
      .where("weak_window_ends_at", ">=", occurredAt)
      .execute();
    return rows.map(toTracked);
  }

  async listActiveInChannel(channelId: Snowflake): Promise<TrackedMessage[]> {
    const rows = await this.db
      .selectFrom("tracked_messages")
      .selectAll()
      .where("channel_id", "=", channelId)
      .where("stopped_at", "is", null)
      .execute();
    return rows.map(toTracked);
  }

  async listActiveInChannelOrParent(channelId: Snowflake): Promise<TrackedMessage[]> {
    const rows = await this.db
      .selectFrom("tracked_messages")
      .selectAll()
      .where("stopped_at", "is", null)
      .where((eb) =>
        eb.or([eb("channel_id", "=", channelId), eb("parent_channel_id", "=", channelId)]),
      )
      .execute();
    return rows.map(toTracked);
  }

  async listExpired(now: UnixMs): Promise<TrackedMessage[]> {
    const rows = await this.db
      .selectFrom("tracked_messages")
      .selectAll()
      .where("stopped_at", "is", null)
      .where("expires_at", "<=", now)
      .execute();
    return rows.map(toTracked);
  }

  async listPendingInitialBackfill(): Promise<TrackedMessage[]> {
    const rows = await this.db
      .selectFrom("tracked_messages")
      .selectAll()
      .where("stopped_at", "is", null)
      .where("status_message_id", "is not", null)
      .where("initial_backfill_at", "is", null)
      .execute();
    return rows.map(toTracked);
  }

  /** Stops an active tracking. Returns false if it was already stopped (idempotent). */
  async stopTracking(
    id: number,
    reason: StopReason,
    at: UnixMs,
    byUserId: Snowflake | null = null,
  ): Promise<boolean> {
    const r = await this.db
      .updateTable("tracked_messages")
      .set({ stopped_at: at, stop_reason: reason, stopped_by_user_id: byUserId })
      .where("id", "=", id)
      .where("stopped_at", "is", null)
      .executeTakeFirst();
    return changed(r.numUpdatedRows);
  }

  async setRenderedHash(id: number, hash: string): Promise<void> {
    await this.db
      .updateTable("tracked_messages")
      .set({ rendered_hash: hash })
      .where("id", "=", id)
      .execute();
  }

  async setInitialBackfillAt(id: number, at: UnixMs): Promise<void> {
    await this.db
      .updateTable("tracked_messages")
      .set({ initial_backfill_at: at })
      .where("id", "=", id)
      .execute();
  }

  async purgeStoppedBefore(cutoff: UnixMs): Promise<number> {
    const r = await this.db
      .deleteFrom("tracked_messages")
      .where("stopped_at", "is not", null)
      .where("stopped_at", "<=", cutoff)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  async purgeGuild(guildId: Snowflake): Promise<number> {
    const r = await this.db
      .deleteFrom("tracked_messages")
      .where("guild_id", "=", guildId)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  /** Startup only: active rows without a companion are left over from a crash mid-start. */
  async deleteUnfinishedStarts(): Promise<number> {
    const r = await this.db
      .deleteFrom("tracked_messages")
      .where("stopped_at", "is", null)
      .where("status_message_id", "is", null)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  // ---------------------------------------------------------------- targets

  async listTargets(trackedMessageId: number, db: Db = this.db): Promise<Target[]> {
    const rows = await db
      .selectFrom("tracking_targets")
      .selectAll()
      .where("tracked_message_id", "=", trackedMessageId)
      .orderBy("added_at")
      .orderBy("user_id")
      .execute();
    return rows.map((r) => ({
      userId: r.user_id,
      addedByUserId: r.added_by_user_id,
      addedAt: r.added_at,
    }));
  }

  async getTarget(
    trackedMessageId: number,
    userId: Snowflake,
    db: Db = this.db,
  ): Promise<Target | undefined> {
    const r = await db
      .selectFrom("tracking_targets")
      .selectAll()
      .where("tracked_message_id", "=", trackedMessageId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return r && { userId: r.user_id, addedByUserId: r.added_by_user_id, addedAt: r.added_at };
  }

  /**
   * Replaces the target set. Removed users lose their target row, evidence and ack for this tracked
   * message (data minimization). Added users get addedAt = `at`.
   */
  async replaceTargets(
    trackedMessageId: number,
    userIds: readonly Snowflake[],
    byUserId: Snowflake,
    at: UnixMs,
  ): Promise<{ added: Snowflake[]; removed: Snowflake[] }> {
    return this.db.transaction().execute(async (trx) => {
      const current = new Set((await this.listTargets(trackedMessageId, trx)).map((t) => t.userId));
      const next = new Set(userIds);
      const added = [...next].filter((u) => !current.has(u));
      const removed = [...current].filter((u) => !next.has(u));
      if (removed.length > 0) {
        for (const table of ["tracking_targets", "evidence", "acknowledgements"] as const) {
          await trx
            .deleteFrom(table)
            .where("tracked_message_id", "=", trackedMessageId)
            .where("user_id", "in", removed)
            .execute();
        }
      }
      if (added.length > 0) {
        await trx
          .insertInto("tracking_targets")
          .values(
            added.map((userId) => ({
              tracked_message_id: trackedMessageId,
              user_id: userId,
              added_by_user_id: byUserId,
              added_at: at,
            })),
          )
          .execute();
      }
      return { added, removed };
    });
  }

  // ---------------------------------------------------------------- evidence

  /**
   * Target check + validity check + write in one transaction.
   * - DIRECT_REPLY / DIRECT_REACTION: INSERT OR IGNORE (keyed by reply id / reaction key).
   * - Weak kinds: earliest-wins upsert on the single '' row.
   */
  async recordEvidence(
    e: Omit<Evidence, "sourceKey"> & { sourceKey?: string },
    isValid: (target: Target) => boolean,
  ): Promise<EvidenceWriteResult> {
    return this.db.transaction().execute(async (trx) => {
      const target = await this.getTarget(e.trackedMessageId, e.userId, trx);
      if (!target) return "not_target";
      if (!isValid(target)) return "invalid";
      const weak = e.kind === "CHANNEL_MESSAGE_AFTER" || e.kind === "TYPING_AFTER";
      const values = {
        tracked_message_id: e.trackedMessageId,
        user_id: e.userId,
        kind: e.kind,
        source_key: weak ? "" : (e.sourceKey ?? ""),
        occurred_at: e.occurredAt,
        observed_at: e.observedAt,
      };
      const r = await trx
        .insertInto("evidence")
        .values(values)
        .onConflict((oc) => {
          const cols = oc.columns(["tracked_message_id", "user_id", "kind", "source_key"]);
          if (!weak) return cols.doNothing();
          return cols
            .doUpdateSet((eb) => ({
              occurred_at: eb.ref("excluded.occurred_at"),
              observed_at: eb.ref("excluded.observed_at"),
            }))
            .where((eb) => eb("excluded.occurred_at", "<", eb.ref("evidence.occurred_at")));
        })
        .executeTakeFirst();
      return changed(r.numInsertedOrUpdatedRows) ? "changed" : "unchanged";
    });
  }

  async deleteEvidence(
    trackedMessageId: number,
    userId: Snowflake,
    kind: EvidenceKind,
    sourceKey: string,
  ): Promise<boolean> {
    const r = await this.db
      .deleteFrom("evidence")
      .where("tracked_message_id", "=", trackedMessageId)
      .where("user_id", "=", userId)
      .where("kind", "=", kind)
      .where("source_key", "=", sourceKey)
      .executeTakeFirst();
    return changed(r.numDeletedRows);
  }

  async deleteReactionsByKeys(trackedMessageId: number, keys: readonly string[]): Promise<boolean> {
    if (keys.length === 0) return false;
    const r = await this.db
      .deleteFrom("evidence")
      .where("tracked_message_id", "=", trackedMessageId)
      .where("kind", "=", "DIRECT_REACTION")
      .where("source_key", "in", keys)
      .executeTakeFirst();
    return changed(r.numDeletedRows);
  }

  async deleteAllReactions(trackedMessageId: number): Promise<boolean> {
    const r = await this.db
      .deleteFrom("evidence")
      .where("tracked_message_id", "=", trackedMessageId)
      .where("kind", "=", "DIRECT_REACTION")
      .executeTakeFirst();
    return changed(r.numDeletedRows);
  }

  /** Removes DIRECT_REPLY rows for deleted reply messages; returns the affected tracked ids. */
  async deleteRepliesByMessageIds(messageIds: readonly Snowflake[]): Promise<number[]> {
    if (messageIds.length === 0) return [];
    const rows = await this.db
      .deleteFrom("evidence")
      .where("kind", "=", "DIRECT_REPLY")
      .where("source_key", "in", messageIds)
      .returning("tracked_message_id")
      .execute();
    return [...new Set(rows.map((r) => r.tracked_message_id))];
  }

  async listEvidence(trackedMessageId: number, db: Db = this.db): Promise<Evidence[]> {
    const rows = await db
      .selectFrom("evidence")
      .selectAll()
      .where("tracked_message_id", "=", trackedMessageId)
      .execute();
    return rows.map((r) => ({
      trackedMessageId: r.tracked_message_id,
      userId: r.user_id,
      kind: r.kind,
      sourceKey: r.source_key,
      occurredAt: r.occurred_at,
      observedAt: r.observed_at,
    }));
  }

  /** Keyset page over DIRECT_REPLY evidence of active tracked messages. Stable under deletion. */
  async pageActiveReplies(after: ReplyCursor | null, limit: number): Promise<ActiveReplyRow[]> {
    const c = after ?? { trackedMessageId: -1, userId: "", sourceKey: "" };
    const rows = await this.db
      .selectFrom("evidence as e")
      .innerJoin("tracked_messages as t", "t.id", "e.tracked_message_id")
      .select(["e.tracked_message_id", "e.user_id", "e.source_key", "t.channel_id"])
      .where("e.kind", "=", "DIRECT_REPLY")
      .where("t.stopped_at", "is", null)
      .where(
        sql<boolean>`(e.tracked_message_id, e.user_id, e.source_key) > (${c.trackedMessageId}, ${c.userId}, ${c.sourceKey})`,
      )
      .orderBy("e.tracked_message_id")
      .orderBy("e.user_id")
      .orderBy("e.source_key")
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      trackedMessageId: r.tracked_message_id,
      userId: r.user_id,
      sourceKey: r.source_key,
      channelId: r.channel_id,
    }));
  }

  // ---------------------------------------------------------------- acknowledgements

  async listAcks(trackedMessageId: number, db: Db = this.db): Promise<Ack[]> {
    const rows = await db
      .selectFrom("acknowledgements")
      .selectAll()
      .where("tracked_message_id", "=", trackedMessageId)
      .execute();
    return rows.map((r) => ({
      userId: r.user_id,
      acknowledgedAt: r.acknowledged_at,
      revokedAt: r.revoked_at,
    }));
  }

  async getAck(trackedMessageId: number, userId: Snowflake): Promise<Ack | undefined> {
    const r = await this.db
      .selectFrom("acknowledgements")
      .selectAll()
      .where("tracked_message_id", "=", trackedMessageId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return r && { userId: r.user_id, acknowledgedAt: r.acknowledged_at, revokedAt: r.revoked_at };
  }

  /**
   * Target-checked acknowledgement. Returns "already" (with the existing ack) if an unrevoked ack
   * exists; a revoked ack is re-armed with the new time.
   */
  async acknowledge(
    trackedMessageId: number,
    userId: Snowflake,
    at: UnixMs,
  ): Promise<{ result: "acknowledged" | "not_target" } | { result: "already"; ack: Ack }> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await this.getTarget(trackedMessageId, userId, trx))) return { result: "not_target" };
      const existing = await trx
        .selectFrom("acknowledgements")
        .selectAll()
        .where("tracked_message_id", "=", trackedMessageId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (existing && existing.revoked_at === null) {
        return {
          result: "already",
          ack: { userId, acknowledgedAt: existing.acknowledged_at, revokedAt: null },
        };
      }
      await trx
        .insertInto("acknowledgements")
        .values({
          tracked_message_id: trackedMessageId,
          user_id: userId,
          acknowledged_at: at,
          revoked_at: null,
        })
        .onConflict((oc) =>
          oc
            .columns(["tracked_message_id", "user_id"])
            .doUpdateSet({ acknowledged_at: at, revoked_at: null }),
        )
        .execute();
      return { result: "acknowledged" };
    });
  }

  async revokeAck(trackedMessageId: number, userId: Snowflake, at: UnixMs): Promise<boolean> {
    const r = await this.db
      .updateTable("acknowledgements")
      .set({ revoked_at: at })
      .where("tracked_message_id", "=", trackedMessageId)
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return changed(r.numUpdatedRows);
  }

  // ---------------------------------------------------------------- views & maintenance

  async loadView(trackedMessageId: number): Promise<TrackingView | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const r = await trx
        .selectFrom("tracked_messages")
        .selectAll()
        .where("id", "=", trackedMessageId)
        .executeTakeFirst();
      if (!r) return undefined;
      return {
        tracked: toTracked(r),
        targets: await this.listTargets(trackedMessageId, trx),
        evidence: await this.listEvidence(trackedMessageId, trx),
        acks: await this.listAcks(trackedMessageId, trx),
      };
    });
  }

  /** Deletion request: removes the user's rows everywhere and anonymizes references to "0". */
  async forgetUser(userId: Snowflake): Promise<number[]> {
    return this.db.transaction().execute(async (trx) => {
      const affected = new Set<number>();
      for (const table of ["tracking_targets", "evidence", "acknowledgements"] as const) {
        const rows = await trx
          .deleteFrom(table)
          .where("user_id", "=", userId)
          .returning("tracked_message_id")
          .execute();
        for (const r of rows) affected.add(r.tracked_message_id);
      }
      for (const col of ["creator_user_id", "source_author_id", "stopped_by_user_id"] as const) {
        const rows = await trx
          .updateTable("tracked_messages")
          .set({ [col]: "0" })
          .where(col, "=", userId)
          .returning("id")
          .execute();
        for (const r of rows) affected.add(r.id);
      }
      return [...affected];
    });
  }

  async getWatermark(): Promise<UnixMs | null> {
    const r = await this.db
      .selectFrom("bot_state")
      .select("value")
      .where("key", "=", WATERMARK_KEY)
      .executeTakeFirst();
    return r ? Number(r.value) : null;
  }

  async setWatermark(at: UnixMs): Promise<void> {
    await this.db
      .insertInto("bot_state")
      .values({ key: WATERMARK_KEY, value: String(at) })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: String(at) }))
      .execute();
  }
}
