import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import type { TargetSource } from "../domain/target-sources.ts";
import type {
  Ack,
  Evidence,
  EvidenceKind,
  Snowflake,
  StopReason,
  Target,
  TrackedMessage,
  TrackingOrigin,
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
  /** Discord channel type of the source location; stored for auto trackings only (D4). */
  channelType?: number | null;
}

export type AutoReconcileResult =
  | { status: "inactive" | "unchanged" }
  | { status: "changed"; added: Snowflake[]; removed: Snowflake[] }
  | { status: "stopped"; removed: Snowflake[] };

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

function toSourceRow(trackedMessageId: number, s: TargetSource) {
  return {
    tracked_message_id: trackedMessageId,
    source_type: s.type,
    source_ref: s.type === "user" ? s.userId : s.roleId,
  };
}

function toSource(r: { source_type: string; source_ref: string }): TargetSource {
  if (r.source_type === "user") return { type: "user", userId: r.source_ref };
  if (r.source_type === "role") return { type: "role", roleId: r.source_ref };
  throw new Error(`unknown tracking source type: ${r.source_type}`);
}

/** Removed users lose their target row, evidence and ack for this tracked message. */
async function deleteUsersFromTracking(
  trx: Transaction<Database>,
  trackedMessageId: number,
  userIds: readonly Snowflake[],
): Promise<void> {
  if (userIds.length === 0) return;
  for (const table of ["tracking_targets", "evidence", "acknowledgements"] as const) {
    await trx
      .deleteFrom(table)
      .where("tracked_message_id", "=", trackedMessageId)
      .where("user_id", "in", userIds)
      .execute();
  }
}

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
    return this.insertWithTargets("manual", input, targetIds, []);
  }

  /**
   * Auto tracking (phase A): tracked message (origin 'auto', channel_type), its frozen
   * tracking_sources and its initial targets in one transaction. Any unique conflict (an active
   * tracking of the message, or any earlier auto tracking of it) writes nothing.
   */
  async insertAutoTracking(
    input: NewTracking,
    targetIds: readonly Snowflake[],
    sources: readonly TargetSource[],
  ): Promise<{ ok: true; tracked: TrackedMessage } | { ok: false; reason: "conflict" }> {
    return this.insertWithTargets("auto", input, targetIds, sources);
  }

  private async insertWithTargets(
    origin: TrackingOrigin,
    input: NewTracking,
    targetIds: readonly Snowflake[],
    sources: readonly TargetSource[],
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
            origin,
            channel_type: origin === "auto" ? (input.channelType ?? null) : null,
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
        if (sources.length > 0) {
          await trx
            .insertInto("tracking_sources")
            .values(sources.map((src) => toSourceRow(row.id, src)))
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

  // ---------------------------------------------------------------- auto trackings (M9)

  /** Stops an active auto tracking, keeping its rows. No-op (false) for manual or stopped rows. */
  async stopAuto(id: number, reason: StopReason, at: UnixMs): Promise<boolean> {
    const r = await this.db
      .updateTable("tracked_messages")
      .set({ stopped_at: at, stop_reason: reason, stopped_by_user_id: null })
      .where("id", "=", id)
      .where("stopped_at", "is", null)
      .where("origin", "=", "auto")
      .executeTakeFirst();
    return changed(r.numUpdatedRows);
  }

  async listTrackingSources(trackedMessageId: number): Promise<TargetSource[]> {
    const rows = await this.db
      .selectFrom("tracking_sources")
      .select(["source_type", "source_ref"])
      .where("tracked_message_id", "=", trackedMessageId)
      .orderBy("source_type")
      .orderBy("source_ref")
      .execute();
    return rows.map(toSource);
  }

  async listActiveAuto(filter: {
    guildId?: Snowflake;
    channelIds?: readonly Snowflake[];
  }): Promise<TrackedMessage[]> {
    if (filter.channelIds?.length === 0) return [];
    let q = this.db
      .selectFrom("tracked_messages")
      .selectAll()
      .where("stopped_at", "is", null)
      .where("origin", "=", "auto");
    if (filter.guildId !== undefined) q = q.where("guild_id", "=", filter.guildId);
    if (filter.channelIds !== undefined) q = q.where("channel_id", "in", filter.channelIds);
    return (await q.orderBy("id").execute()).map(toTracked);
  }

  /** Active auto trackings of the guild whose frozen sources contain any of the roles. */
  async listActiveAutoIdsByMessageRoles(
    guildId: Snowflake,
    roleIds: readonly Snowflake[],
  ): Promise<number[]> {
    if (roleIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("tracking_sources as s")
      .innerJoin("tracked_messages as t", "t.id", "s.tracked_message_id")
      .select("t.id")
      .distinct()
      .where("s.source_type", "=", "role")
      .where("s.source_ref", "in", roleIds)
      .where("t.guild_id", "=", guildId)
      .where("t.stopped_at", "is", null)
      .where("t.origin", "=", "auto")
      .orderBy("t.id")
      .execute();
    return rows.map((r) => r.id);
  }

  async listActiveAutoIdsWithTarget(guildId: Snowflake, userId: Snowflake): Promise<number[]> {
    const rows = await this.db
      .selectFrom("tracking_targets as g")
      .innerJoin("tracked_messages as t", "t.id", "g.tracked_message_id")
      .select("t.id")
      .where("g.user_id", "=", userId)
      .where("t.guild_id", "=", guildId)
      .where("t.stopped_at", "is", null)
      .where("t.origin", "=", "auto")
      .orderBy("t.id")
      .execute();
    return rows.map((r) => r.id);
  }

  /** Distinct role sources of the guild's active auto trackings (referenced-role input). */
  async activeMessageRoleIds(guildId: Snowflake): Promise<Snowflake[]> {
    const rows = await this.db
      .selectFrom("tracking_sources as s")
      .innerJoin("tracked_messages as t", "t.id", "s.tracked_message_id")
      .select("s.source_ref")
      .distinct()
      .where("s.source_type", "=", "role")
      .where("t.guild_id", "=", guildId)
      .where("t.stopped_at", "is", null)
      .where("t.origin", "=", "auto")
      .execute();
    return rows.map((r) => r.source_ref);
  }

  /**
   * The single destructive target path for auto trackings (spec §6.2 step 4). Touches only an
   * active row with origin 'auto'. Removed users lose target/evidence/ack; added users get
   * addedAt = at, addedBy '0'. An empty desired set deletes every target and then stops with
   * no_eligible_targets (D7), in the same transaction.
   */
  async reconcileAutoTargets(
    trackedMessageId: number,
    desired: readonly Snowflake[],
    at: UnixMs,
  ): Promise<AutoReconcileResult> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("tracked_messages")
        .select("id")
        .where("id", "=", trackedMessageId)
        .where("stopped_at", "is", null)
        .where("origin", "=", "auto")
        .executeTakeFirst();
      if (!row) return { status: "inactive" as const };
      const current = (await this.listTargets(trackedMessageId, trx)).map((t) => t.userId);
      const currentSet = new Set(current);
      const next = new Set(desired);
      const removed = current.filter((u) => !next.has(u));
      if (next.size === 0) {
        await deleteUsersFromTracking(trx, trackedMessageId, removed);
        await trx
          .updateTable("tracked_messages")
          .set({ stopped_at: at, stop_reason: "no_eligible_targets", stopped_by_user_id: null })
          .where("id", "=", trackedMessageId)
          .execute();
        return { status: "stopped" as const, removed };
      }
      const added = [...next].filter((u) => !currentSet.has(u));
      if (added.length === 0 && removed.length === 0) return { status: "unchanged" as const };
      await deleteUsersFromTracking(trx, trackedMessageId, removed);
      if (added.length > 0) {
        await trx
          .insertInto("tracking_targets")
          .values(
            added.map((userId) => ({
              tracked_message_id: trackedMessageId,
              user_id: userId,
              added_by_user_id: "0",
              added_at: at,
            })),
          )
          .execute();
      }
      return { status: "changed" as const, added, removed };
    });
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
      await deleteUsersFromTracking(trx, trackedMessageId, removed);
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

  /**
   * Deletion request: removes the user's rows everywhere (including their `user` tracking sources)
   * and anonymizes references (tracking and policy actors) to "0".
   * Active AUTO trackings the user authored are stopped first: once source_author_id is anonymized
   * the reconciler could no longer exclude the author from their own card (spec §12.6).
   */
  async forgetUser(userId: Snowflake, at: UnixMs = Date.now()): Promise<number[]> {
    return this.db.transaction().execute(async (trx) => {
      const affected = new Set<number>();
      const authored = await trx
        .updateTable("tracked_messages")
        .set({ stopped_at: at, stop_reason: "manual", stopped_by_user_id: null })
        .where("source_author_id", "=", userId)
        .where("origin", "=", "auto")
        .where("stopped_at", "is", null)
        .returning("id")
        .execute();
      for (const r of authored) affected.add(r.id);
      for (const table of ["tracking_targets", "evidence", "acknowledgements"] as const) {
        const rows = await trx
          .deleteFrom(table)
          .where("user_id", "=", userId)
          .returning("tracked_message_id")
          .execute();
        for (const r of rows) affected.add(r.tracked_message_id);
      }
      await trx
        .updateTable("tracking_targets")
        .set({ added_by_user_id: "0" })
        .where("added_by_user_id", "=", userId)
        .execute();
      for (const col of ["creator_user_id", "source_author_id", "stopped_by_user_id"] as const) {
        const rows = await trx
          .updateTable("tracked_messages")
          .set({ [col]: "0" })
          .where(col, "=", userId)
          .returning("id")
          .execute();
        for (const r of rows) affected.add(r.id);
      }
      const sources = await trx
        .deleteFrom("tracking_sources")
        .where("source_type", "=", "user")
        .where("source_ref", "=", userId)
        .returning("tracked_message_id")
        .execute();
      for (const r of sources) affected.add(r.tracked_message_id);
      for (const col of ["created_by_user_id", "updated_by_user_id", "state_changed_by"] as const) {
        await trx
          .updateTable("auto_track_policies")
          .set({ [col]: "0" })
          .where(col, "=", userId)
          .execute();
      }
      await trx
        .updateTable("auto_track_policy_sources")
        .set({ added_by_user_id: "0" })
        .where("added_by_user_id", "=", userId)
        .execute();
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
