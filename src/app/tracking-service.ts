import type { Repository, TrackingView } from "../db/repository.ts";
import { isValidEvidence } from "../domain/evidence-validity.ts";
import type { Policy } from "../domain/policy.ts";
import { reactionKeysForEmoji, type Signal } from "../domain/signals.ts";
import type { TargetSource } from "../domain/target-sources.ts";
import type {
  Ack,
  EvidenceKind,
  Snowflake,
  StopReason,
  TrackedMessage,
  UnixMs,
} from "../domain/types.ts";
import type {
  CardRenderer,
  Clock,
  CreateCompanionError,
  DiscordPort,
  Logger,
  RenderedCard,
} from "./ports.ts";
import type { DirtySink } from "./render-scheduler.ts";
import { projectView } from "./view.ts";

export interface StartInput {
  guildId: Snowflake;
  channelId: Snowflake;
  parentChannelId: Snowflake | null;
  sourceMessageId: Snowflake;
  sourceAuthorId: Snowflake;
  sourceCreatedAt: UnixMs;
  creatorUserId: Snowflake;
  /** Already passed through eligibleTargets(); must be non-empty. */
  targets: readonly Snowflake[];
}

export interface AutoInsertInput {
  guildId: Snowflake;
  channelId: Snowflake;
  channelType: number;
  sourceMessageId: Snowflake;
  sourceAuthorId: Snowflake;
  sourceCreatedAt: UnixMs;
  /** Desired targets (union, deduped, author and bots removed, within the D8 limit). */
  targets: readonly Snowflake[];
  /** Frozen message sources (explicit users, mentioned roles); policy roles stay live. */
  sources: readonly TargetSource[];
}

export type AutoPublishResult =
  | { status: "published" }
  | { status: "rolled_back"; error: CreateCompanionError }
  | { status: "gone" };

export type StartResult =
  | { kind: "started"; tracked: TrackedMessage; statusMessageId: Snowflake }
  | { kind: "already"; tracked: TrackedMessage; statusMessageId: Snowflake }
  | { kind: "being_set_up" }
  | { kind: "verify_failed" }
  | { kind: "create_failed"; error: CreateCompanionError };

export type AckResult =
  | { kind: "not_found" }
  | { kind: "stopped"; tracked: TrackedMessage }
  | { kind: "not_target" }
  | { kind: "already"; ack: Ack }
  | { kind: "acknowledged"; card: RenderedCard };

export interface SignalScope {
  onlyTrackedId?: number;
  onlyUserIds?: ReadonlySet<Snowflake>;
  /** Reconciler: rethrow persistence failures instead of invoking failure hooks. */
  propagateErrors?: boolean;
}

export interface SignalFailureHooks {
  /** A MESSAGE-derived write failed: freeze the watermark and schedule a gap scan. */
  onMessageSignalFailed(): void;
  /** A reaction write failed: schedule a reaction pass for that source. */
  onReactionSignalFailed(sourceMessageId: Snowflake): void;
}

export class TrackingService {
  private readonly repo: Repository;
  private readonly port: DiscordPort;
  private readonly renderer: CardRenderer;
  private readonly scheduler: DirtySink;
  private readonly clock: Clock;
  private readonly policy: Policy;
  private readonly logger: Logger;
  hooks: SignalFailureHooks = { onMessageSignalFailed() {}, onReactionSignalFailed() {} };

  constructor(deps: {
    repo: Repository;
    port: DiscordPort;
    renderer: CardRenderer;
    scheduler: DirtySink;
    clock: Clock;
    policy: Policy;
    logger: Logger;
  }) {
    this.repo = deps.repo;
    this.port = deps.port;
    this.renderer = deps.renderer;
    this.scheduler = deps.scheduler;
    this.clock = deps.clock;
    this.policy = deps.policy;
    this.logger = deps.logger;
  }

  // ------------------------------------------------------------------ start

  /**
   * Start flow (§6.1 steps 3 and 5). Verifies an existing companion before answering "already";
   * rolls back the row on any companion creation failure.
   */
  async startTracking(input: StartInput): Promise<StartResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.checkExisting(input.sourceMessageId);
      if (existing.kind !== "none") return existing;

      const now = this.clock.now();
      const inserted = await this.repo.insertTracking(
        {
          guildId: input.guildId,
          channelId: input.channelId,
          parentChannelId: input.parentChannelId,
          sourceMessageId: input.sourceMessageId,
          sourceAuthorId: input.sourceAuthorId,
          sourceCreatedAt: input.sourceCreatedAt,
          creatorUserId: input.creatorUserId,
          createdAt: now,
          weakWindowEndsAt: now + this.policy.weakWindowMs,
          expiresAt: now + this.policy.trackingTtlMs,
        },
        input.targets,
      );
      if (!inserted.ok) continue; // a concurrent start won; re-run the existing-row checks once

      const tracked = inserted.tracked;
      const card = await this.renderCard(tracked.id);
      if (!card) return { kind: "create_failed", error: { kind: "Unknown" } };

      const created = await this.port.createCompanion({
        channelId: tracked.channelId,
        sourceMessageId: tracked.sourceMessageId,
        nonce: `sb1t${tracked.id}`,
        body: card.body,
      });
      if (!created.ok) {
        await this.repo.deleteTracking(tracked.id);
        return { kind: "create_failed", error: created.error };
      }
      try {
        await this.repo.setStatusMessageId(tracked.id, created.messageId);
        await this.repo.setRenderedHash(tracked.id, card.hash);
      } catch (error) {
        this.logger.error({ trackedId: tracked.id, err: error }, "failed to store companion id");
        await this.port.deleteMessage(tracked.channelId, created.messageId).catch(() => {});
        await this.repo.deleteTracking(tracked.id).catch(() => {});
        return { kind: "create_failed", error: { kind: "Unknown" } };
      }
      return {
        kind: "started",
        tracked: { ...tracked, statusMessageId: created.messageId, renderedHash: card.hash },
        statusMessageId: created.messageId,
      };
    }
    return { kind: "being_set_up" };
  }

  /**
   * Auto tracking phase A (spec §8.1): one transaction, creator = author, targets added at
   * createdAt, status_message_id NULL. Any active tracking of the message, or any earlier auto
   * tracking of it, is a silent "exists".
   */
  async insertAutoTracking(
    input: AutoInsertInput,
  ): Promise<{ ok: true; tracked: TrackedMessage } | { ok: false; reason: "exists" }> {
    const now = this.clock.now();
    const r = await this.repo.insertAutoTracking(
      {
        guildId: input.guildId,
        channelId: input.channelId,
        parentChannelId: null,
        sourceMessageId: input.sourceMessageId,
        sourceAuthorId: input.sourceAuthorId,
        sourceCreatedAt: input.sourceCreatedAt,
        creatorUserId: input.sourceAuthorId,
        createdAt: now,
        weakWindowEndsAt: now + this.policy.weakWindowMs,
        expiresAt: now + this.policy.trackingTtlMs,
        channelType: input.channelType,
      },
      input.targets,
      input.sources,
    );
    return r.ok ? r : { ok: false, reason: "exists" };
  }

  /**
   * Auto tracking phase B (outside the guild queue): post the companion as a reply, store its id,
   * then markDirty so changes made while publishing (member events, a reconcile stop) render.
   * Any failure rolls the row back (sources cascade).
   */
  async publishAutoCompanion(trackedId: number): Promise<AutoPublishResult> {
    const tracked = await this.repo.getTracked(trackedId);
    if (!tracked || tracked.statusMessageId !== null) return { status: "gone" };
    const card = await this.renderCard(trackedId);
    if (!card) return { status: "gone" };
    const created = await this.port.createCompanion({
      channelId: tracked.channelId,
      sourceMessageId: tracked.sourceMessageId,
      nonce: `sb1t${tracked.id}`,
      body: card.body,
    });
    if (!created.ok) {
      await this.repo.deleteTracking(tracked.id);
      return { status: "rolled_back", error: created.error };
    }
    try {
      await this.repo.setStatusMessageId(tracked.id, created.messageId);
      await this.repo.setRenderedHash(tracked.id, card.hash);
    } catch (error) {
      this.logger.error({ trackedId: tracked.id, err: error }, "failed to store companion id");
      await this.port.deleteMessage(tracked.channelId, created.messageId).catch(() => {});
      await this.repo.deleteTracking(tracked.id).catch(() => {});
      return { status: "rolled_back", error: { kind: "Unknown" } };
    }
    this.scheduler.markDirty(tracked.id);
    return { status: "published" };
  }

  /**
   * Existing active tracking for a source (§6.1 step 3). A companion that no longer exists (deleted
   * while the bot couldn't see it) makes the row stale: it is stopped as status_deleted → "none".
   * A NULL status_message_id means a start is in flight; no jump link is ever built from it.
   */
  async checkExisting(
    sourceMessageId: Snowflake,
  ): Promise<
    | { kind: "none" }
    | { kind: "already"; tracked: TrackedMessage; statusMessageId: Snowflake }
    | { kind: "being_set_up" }
    | { kind: "verify_failed" }
  > {
    const existing = await this.repo.findActiveBySource(sourceMessageId);
    if (!existing) return { kind: "none" };
    if (existing.statusMessageId === null) return { kind: "being_set_up" };
    const look = await this.port.getMessage(existing.channelId, existing.statusMessageId);
    if (look.ok) {
      return { kind: "already", tracked: existing, statusMessageId: existing.statusMessageId };
    }
    if (look.class !== "NotFound") {
      this.logger.warn(
        { trackedId: existing.id, code: look.code },
        "could not verify existing companion",
      );
      return { kind: "verify_failed" };
    }
    this.logger.info({ trackedId: existing.id }, "stale tracking: companion was deleted");
    await this.repo.stopTracking(existing.id, "status_deleted", this.clock.now());
    return { kind: "none" };
  }

  // ------------------------------------------------------------------ rendering helpers

  async loadView(trackedId: number): Promise<TrackingView | undefined> {
    return this.repo.loadView(trackedId);
  }

  async renderCard(trackedId: number): Promise<RenderedCard | undefined> {
    const view = await this.repo.loadView(trackedId);
    if (!view) return undefined;
    return this.renderer.render({ tracked: view.tracked, rows: projectView(view) });
  }

  // ------------------------------------------------------------------ interactions

  async acknowledge(trackedId: number, userId: Snowflake, at: UnixMs): Promise<AckResult> {
    const tracked = await this.repo.getTracked(trackedId);
    if (!tracked) return { kind: "not_found" };
    if (tracked.stoppedAt !== null) return { kind: "stopped", tracked };
    const r = await this.repo.acknowledge(trackedId, userId, at);
    if (r.result === "not_target") return { kind: "not_target" };
    if (r.result === "already") return { kind: "already", ack: r.ack };
    const card = await this.renderCard(trackedId);
    if (!card) return { kind: "not_found" };
    return { kind: "acknowledged", card };
  }

  /** Revokes the caller's own ack. The caller re-renders the companion after responding. */
  async undo(trackedId: number, userId: Snowflake, at: UnixMs): Promise<boolean> {
    return this.repo.revokeAck(trackedId, userId, at);
  }

  async setTargets(
    trackedId: number,
    userIds: readonly Snowflake[],
    byUserId: Snowflake,
    at: UnixMs,
  ): Promise<{ added: Snowflake[]; removed: Snowflake[] }> {
    return this.repo.replaceTargets(trackedId, userIds, byUserId, at);
  }

  /** Stops tracking (idempotent). Rendering is the caller's decision; see stopAndRender. */
  async stop(
    trackedId: number,
    reason: StopReason,
    byUserId: Snowflake | null,
    at: UnixMs = this.clock.now(),
  ): Promise<boolean> {
    return this.repo.stopTracking(trackedId, reason, at, byUserId);
  }

  async stopAndRender(
    trackedId: number,
    reason: StopReason,
    byUserId: Snowflake | null = null,
    at: UnixMs = this.clock.now(),
  ): Promise<void> {
    const changed = await this.stop(trackedId, reason, byUserId, at);
    if (changed && reason !== "status_deleted" && reason !== "channel_deleted") {
      await this.scheduler.renderNow(trackedId);
    }
  }

  // ------------------------------------------------------------------ signals

  /** The only matcher from normalized signals to tracked messages and evidence. */
  async recordSignal(signal: Signal, scope: SignalScope = {}): Promise<void> {
    try {
      await this.applySignal(signal, scope);
    } catch (error) {
      if (scope.propagateErrors) throw error;
      this.logger.error({ signal: signal.t, err: error }, "signal processing failed");
      if (signal.t === "MESSAGE") this.hooks.onMessageSignalFailed();
      else if (signal.t === "REACTION_ADD" || signal.t === "REACTION_REMOVE")
        this.hooks.onReactionSignalFailed(signal.messageId);
      // TYPING: best-effort, lost.
    }
  }

  private inScope(tracked: TrackedMessage, userId: Snowflake | null, scope: SignalScope): boolean {
    if (scope.onlyTrackedId !== undefined && tracked.id !== scope.onlyTrackedId) return false;
    if (userId !== null && scope.onlyUserIds && !scope.onlyUserIds.has(userId)) return false;
    return true;
  }

  private async writeEvidence(
    tracked: TrackedMessage,
    userId: Snowflake,
    kind: EvidenceKind,
    sourceKey: string,
    occurredAt: UnixMs | null,
  ): Promise<void> {
    const result = await this.repo.recordEvidence(
      {
        trackedMessageId: tracked.id,
        userId,
        kind,
        sourceKey,
        occurredAt,
        observedAt: this.clock.now(),
      },
      (target) => isValidEvidence({ kind, occurredAt }, target.addedAt, tracked),
    );
    if (result === "changed") this.scheduler.markDirty(tracked.id);
  }

  private async applySignal(signal: Signal, scope: SignalScope): Promise<void> {
    switch (signal.t) {
      case "MESSAGE": {
        if (signal.replyToMessageId !== undefined) {
          const tracked = await this.repo.findActiveBySource(signal.replyToMessageId);
          if (tracked && this.inScope(tracked, signal.authorId, scope)) {
            await this.writeEvidence(
              tracked,
              signal.authorId,
              "DIRECT_REPLY",
              signal.messageId,
              signal.occurredAt,
            );
          }
        }
        for (const tracked of await this.repo.listActiveInWeakWindow(
          signal.channelId,
          signal.occurredAt,
        )) {
          if (!this.inScope(tracked, signal.authorId, scope)) continue;
          await this.writeEvidence(
            tracked,
            signal.authorId,
            "CHANNEL_MESSAGE_AFTER",
            "",
            signal.occurredAt,
          );
        }
        return;
      }
      case "TYPING": {
        for (const tracked of await this.repo.listActiveInWeakWindow(
          signal.channelId,
          signal.occurredAt,
        )) {
          if (!this.inScope(tracked, signal.userId, scope)) continue;
          await this.writeEvidence(tracked, signal.userId, "TYPING_AFTER", "", signal.occurredAt);
        }
        return;
      }
      case "REACTION_ADD": {
        const tracked = await this.repo.findActiveBySource(signal.messageId);
        if (tracked && this.inScope(tracked, signal.userId, scope)) {
          await this.writeEvidence(
            tracked,
            signal.userId,
            "DIRECT_REACTION",
            signal.reactionKey,
            null,
          );
        }
        return;
      }
      case "REACTION_REMOVE": {
        const tracked = await this.repo.findActiveBySource(signal.messageId);
        if (!tracked || !this.inScope(tracked, signal.userId, scope)) return;
        if (
          await this.repo.deleteEvidence(
            tracked.id,
            signal.userId,
            "DIRECT_REACTION",
            signal.reactionKey,
          )
        )
          this.scheduler.markDirty(tracked.id);
        return;
      }
      case "REACTION_REMOVE_ALL": {
        const tracked = await this.repo.findActiveBySource(signal.messageId);
        if (tracked && (await this.repo.deleteAllReactions(tracked.id)))
          this.scheduler.markDirty(tracked.id);
        return;
      }
      case "REACTION_REMOVE_EMOJI": {
        const tracked = await this.repo.findActiveBySource(signal.messageId);
        if (
          tracked &&
          (await this.repo.deleteReactionsByKeys(tracked.id, reactionKeysForEmoji(signal.emojiKey)))
        )
          this.scheduler.markDirty(tracked.id);
        return;
      }
      case "MESSAGES_DELETED": {
        for (const id of await this.repo.deleteRepliesByMessageIds(signal.messageIds))
          this.scheduler.markDirty(id);
        for (const messageId of signal.messageIds) {
          const source = await this.repo.findActiveBySource(messageId);
          if (source) await this.stopAndRender(source.id, "source_deleted");
          for (const t of await this.repo.findActiveByStatusMessage(messageId))
            await this.stop(t.id, "status_deleted", null);
        }
        return;
      }
      case "CHANNEL_DELETED": {
        for (const t of await this.repo.listActiveInChannelOrParent(signal.channelId))
          await this.stop(t.id, "channel_deleted", null);
        return;
      }
      case "THREAD_UNARCHIVED": {
        for (const t of await this.repo.listActiveInChannel(signal.threadId))
          this.scheduler.markDirty(t.id);
        return;
      }
      case "GUILD_REMOVED": {
        const n = await this.repo.purgeGuild(signal.guildId);
        this.logger.info({ guildId: signal.guildId, purged: n }, "bot removed from guild; purged");
        return;
      }
    }
  }
}
