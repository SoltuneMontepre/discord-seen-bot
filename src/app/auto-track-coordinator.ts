import type { PolicyRepository } from "../db/policy-repository.ts";
import type { Repository } from "../db/repository.ts";
import type { RoleDeletionStore } from "../db/role-deletion.ts";
import type { Policy } from "../domain/policy.ts";
import { timestampOf } from "../domain/snowflake.ts";
import type {
  AutoTrackCandidate,
  MemberStateEvent,
  TargetSource,
} from "../domain/target-sources.ts";
import type { Snowflake, TrackedMessage, UnixMs } from "../domain/types.ts";
import type { GuildAutoTrackHealth } from "./guild-auto-track-health.ts";
import type { GuildQueue } from "./guild-queue.ts";
import type { MemberRoleIndex } from "./member-role-index.ts";
import type { MemberStateRebuilder } from "./member-state-rebuilder.ts";
import type { Clock, Logger } from "./ports.ts";
import type { Reconciler } from "./reconciler.ts";
import { isRoleDependent } from "./role-dependence.ts";
import type { TargetReconciler } from "./target-reconciler.ts";
import type { TargetResolverRegistry } from "./target-resolution.ts";
import type { TrackingService } from "./tracking-service.ts";

/** D4: channel policies apply only to exact GUILD_TEXT (0) / GUILD_ANNOUNCEMENT (5) channels. */
const POLICY_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5]);

/**
 * Entry point for M9 events. Phase A (sources → pause gate → desired → D8 → insert) runs inside the
 * guild queue; phase B (publish, initial backfill) runs outside it. Member/role/guild events each
 * run as one guild-queue task. The only enqueuers here are onTopLevelMessage, onMemberEvent and
 * requestReferencedRolePrune; nothing inside a task calls them.
 */
export class AutoTrackCoordinator {
  private readonly deps: {
    features: { mentionAutoTrack: boolean; roleTargets: boolean };
    repo: Repository;
    policies: PolicyRepository;
    registry: TargetResolverRegistry;
    /** Role-state subsystem: present only when role targets are on. */
    health: GuildAutoTrackHealth | undefined;
    index: MemberRoleIndex | undefined;
    rebuilder: MemberStateRebuilder | undefined;
    roleDeletion: RoleDeletionStore;
    reconciler: TargetReconciler;
    queue: GuildQueue;
    service: Pick<TrackingService, "insertAutoTracking" | "publishAutoCompanion">;
    backfill: Pick<Reconciler, "initialBackfill">;
    policy: Pick<Policy, "autoTrackMaxTargets" | "overLimitLogIntervalMs">;
    clock: Clock;
    logger: Logger;
  };
  private readonly lastWarnAt = new Map<string, number>();

  constructor(deps: AutoTrackCoordinator["deps"]) {
    this.deps = deps;
  }

  /** EXTERNAL: live top-level MESSAGE_CREATE candidate (never the gap scan, D3). */
  async onTopLevelMessage(c: AutoTrackCandidate): Promise<void> {
    let tracked: TrackedMessage | undefined;
    try {
      tracked = await this.deps.queue.run(c.guildId, () => this.createInQueue(c));
    } catch (err) {
      this.deps.logger.error({ messageId: c.messageId, err }, "auto-track creation failed");
      return;
    }
    if (tracked) await this.publish(tracked);
  }

  /** EXTERNAL: one guild-queue task per member-state event (role flag on only). */
  async onMemberEvent(e: MemberStateEvent): Promise<void> {
    const g = e.guildId;
    try {
      switch (e.t) {
        case "guild_available":
          this.deps.rebuilder?.requestRebuild(g, "guild_create");
          return;
        case "guild_unavailable":
          await this.deps.queue.run(g, async () => this.deps.health?.set(g, "unavailable"));
          return;
        case "guild_removed":
          await this.deps.queue.run(g, async () => {
            this.deps.index?.clear(g);
            this.deps.health?.forget(g);
          });
          return;
        case "member_upsert":
          await this.deps.queue.run(g, () =>
            this.memberUpsertInQueue(g, e.userId, e.roleIds, e.bot),
          );
          return;
        case "member_remove":
          await this.deps.queue.run(g, () => this.memberRemoveInQueue(g, e.userId));
          return;
        case "role_delete":
          await this.deps.queue.run(g, () =>
            this.applyRoleDeletionInQueue(g, e.roleId, this.deps.clock.now()),
          );
          return;
      }
    } catch (err) {
      this.deps.logger.error({ guildId: g, event: e.t, err }, "member-state event failed");
    }
  }

  /** Fresh READY: member state must be rebuilt for every guild (no queue). */
  onReady(): void {
    this.deps.health?.resetAll();
  }

  /** EXTERNAL (sweeper tick): shrink the index to roles still referenced. */
  requestReferencedRolePrune(guildId: Snowflake): void {
    this.deps.queue
      .runKeyed(guildId, "prune-referenced-roles", () => this.pruneReferencedRolesInQueue(guildId))
      .catch((err) => this.deps.logger.error({ guildId, err }, "referenced-role prune failed"));
  }

  /**
   * In-queue, shrink-only: roles no longer referenced by an enabled policy or an active auto
   * tracking leave the index. Roles referenced but not indexed are NOT added (that needs a rebuild).
   */
  async pruneReferencedRolesInQueue(guildId: Snowflake): Promise<void> {
    const { index } = this.deps;
    if (!index) return;
    this.deps.queue.assertInQueue(guildId);
    const referenced = new Set([
      ...(await this.deps.policies.referencedRoleIds(guildId)),
      ...(await this.deps.repo.activeMessageRoleIds(guildId)),
    ]);
    const keep = [...index.referencedRoles(guildId)].filter((r) => referenced.has(r));
    const { droppedRoleIds } = index.setReferencedRoles(guildId, keep);
    if (droppedRoleIds.length > 0) {
      this.deps.logger.debug({ guildId, droppedRoleIds }, "pruned unreferenced roles from index");
    }
  }

  // ------------------------------------------------------------------ member events (in queue)

  private async memberUpsertInQueue(
    guildId: Snowflake,
    userId: Snowflake,
    roleIds: readonly Snowflake[],
    bot: boolean,
  ): Promise<void> {
    const { index, health } = this.deps;
    if (!index || !health || health.isPaused(guildId)) return;
    const { changedRoleIds } = index.upsert(guildId, userId, [...roleIds], bot);
    if (changedRoleIds.length === 0) return;
    const ids = new Set(
      await this.deps.repo.listActiveAutoIdsByMessageRoles(guildId, changedRoleIds),
    );
    const channelIds = await this.deps.policies.enabledChannelIdsForRoles(guildId, changedRoleIds);
    if (channelIds.length > 0) {
      for (const t of await this.deps.repo.listActiveAuto({ guildId, channelIds })) {
        if (t.channelType !== null && POLICY_CHANNEL_TYPES.has(t.channelType)) ids.add(t.id);
      }
    }
    await this.reconcileAll(ids);
  }

  private async memberRemoveInQueue(guildId: Snowflake, userId: Snowflake): Promise<void> {
    const { index, health } = this.deps;
    if (!index || !health || health.isPaused(guildId)) return;
    index.remove(guildId, userId);
    const ids = await this.deps.repo.listActiveAutoIdsWithTarget(guildId, userId);
    await this.reconcileAll(ids); // explicit sources keep the user (E6)
  }

  /** D9 live deletion: one pruning transaction, then reconcile (deferred to recovery if paused). */
  private async applyRoleDeletionInQueue(
    guildId: Snowflake,
    roleId: Snowflake,
    at: UnixMs,
  ): Promise<void> {
    this.deps.queue.assertInQueue(guildId);
    const r = await this.deps.roleDeletion.apply(guildId, roleId, at);
    this.deps.index?.dropRole(guildId, roleId);
    if (this.deps.health && !this.deps.health.isPaused(guildId)) {
      const ids = new Set(r.affectedTrackingIds);
      if (r.affectedChannelIds.length > 0) {
        const ts = await this.deps.repo.listActiveAuto({
          guildId,
          channelIds: r.affectedChannelIds,
        });
        for (const t of ts) ids.add(t.id);
      }
      await this.reconcileAll(ids);
    }
    await this.pruneReferencedRolesInQueue(guildId);
  }

  private async reconcileAll(ids: Iterable<number>): Promise<void> {
    for (const id of [...ids].sort((a, b) => a - b)) {
      await this.deps.reconciler.reconcileInQueue(id);
    }
  }

  // ------------------------------------------------------------------ phase A (in queue)

  private async createInQueue(c: AutoTrackCandidate): Promise<TrackedMessage | undefined> {
    const stored: TargetSource[] = [
      ...c.explicitUserIds.map((userId): TargetSource => ({ type: "user", userId })),
      ...c.mentionedRoleIds.map((roleId): TargetSource => ({ type: "role", roleId })),
    ];
    const sources = [...stored, ...(await this.policyRoleSources(c, c.mentionedRoleIds))];
    if (sources.length === 0) return undefined;

    if (isRoleDependent(sources)) {
      if (!this.deps.health || this.deps.health.isPaused(c.guildId)) {
        this.deps.logger.debug(
          { guildId: c.guildId, messageId: c.messageId },
          "auto-track skipped: member state paused",
        );
        return undefined;
      }
      if (!(await this.ensureIndexed(c.guildId, sources))) return undefined;
    }

    const desired = this.deps.registry.desiredTargets(sources, {
      guildId: c.guildId,
      sourceAuthorId: c.authorId,
    });
    if (desired.length === 0) return undefined;
    const limit = this.deps.policy.autoTrackMaxTargets;
    if (desired.length > limit) {
      this.warnRateLimited(
        `limit:${c.channelId}`,
        { guildId: c.guildId, channelId: c.channelId, resolved: desired.length, limit },
        "auto-track skipped: too many eligible members",
      );
      return undefined;
    }
    const r = await this.deps.service.insertAutoTracking({
      guildId: c.guildId,
      channelId: c.channelId,
      channelType: c.channelType,
      sourceMessageId: c.messageId,
      sourceAuthorId: c.authorId,
      sourceCreatedAt: timestampOf(c.messageId),
      targets: desired,
      sources: stored,
    });
    return r.ok ? r.tracked : undefined;
  }

  /** Live policy roles for the exact text/announcement channel (D4), minus mentioned roles. */
  private async policyRoleSources(
    c: AutoTrackCandidate,
    mentioned: readonly Snowflake[],
  ): Promise<TargetSource[]> {
    if (!this.deps.features.roleTargets || !POLICY_CHANNEL_TYPES.has(c.channelType)) return [];
    const have = new Set(mentioned);
    return (await this.deps.policies.enabledRoleIdsForChannel(c.channelId))
      .filter((r) => !have.has(r))
      .map((roleId): TargetSource => ({ type: "role", roleId }));
  }

  /**
   * A newly mentioned role grows the referenced-role set (spec §9.2 trigger): extend the index
   * in-queue before resolving. A failed extension fails closed.
   */
  private async ensureIndexed(
    guildId: Snowflake,
    sources: readonly TargetSource[],
  ): Promise<boolean> {
    const { index, rebuilder } = this.deps;
    if (!index || !rebuilder) return false;
    const known = index.referencedRoles(guildId);
    const missing = [
      ...new Set(
        sources.flatMap((s) => (s.type === "role" && !known.has(s.roleId) ? [s.roleId] : [])),
      ),
    ];
    if (missing.length === 0) return true;
    const r = await rebuilder.rebuildNowInQueue(guildId, "roles_grew", {
      extraReferencedRoleIds: missing,
      reconcile: false,
    });
    return r === "healthy";
  }

  // ------------------------------------------------------------------ phase B (outside queue)

  private async publish(t: TrackedMessage): Promise<void> {
    const r = await this.deps.service.publishAutoCompanion(t.id);
    if (r.status === "rolled_back") {
      this.warnRateLimited(
        `publish:${t.channelId}`,
        { guildId: t.guildId, channelId: t.channelId, error: r.error },
        "auto-track companion could not be posted",
      );
      return;
    }
    if (r.status === "published") await this.deps.backfill.initialBackfill(t.id);
  }

  private warnRateLimited(key: string, obj: object, msg: string): void {
    const now = this.deps.clock.now();
    const last = this.lastWarnAt.get(key);
    if (last !== undefined && now - last < this.deps.policy.overLimitLogIntervalMs) return;
    this.lastWarnAt.set(key, now);
    this.deps.logger.warn(obj, msg);
  }
}
