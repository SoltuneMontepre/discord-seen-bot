import type { PolicyRepository } from "../db/policy-repository.ts";
import type { Repository } from "../db/repository.ts";
import type { Policy } from "../domain/policy.ts";
import { timestampOf } from "../domain/snowflake.ts";
import type { AutoTrackCandidate, TargetSource } from "../domain/target-sources.ts";
import type { Snowflake, TrackedMessage } from "../domain/types.ts";
import type { GuildAutoTrackHealth } from "./guild-auto-track-health.ts";
import type { GuildQueue } from "./guild-queue.ts";
import type { MemberRoleIndex } from "./member-role-index.ts";
import type { MemberStateRebuilder } from "./member-state-rebuilder.ts";
import type { Clock, Logger } from "./ports.ts";
import type { Reconciler } from "./reconciler.ts";
import { isRoleDependent } from "./role-dependence.ts";
import type { TargetResolverRegistry } from "./target-resolution.ts";
import type { TrackingService } from "./tracking-service.ts";

/** D4: channel policies apply only to exact GUILD_TEXT (0) / GUILD_ANNOUNCEMENT (5) channels. */
const POLICY_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5]);

/**
 * Entry point for M9 events. Phase A (sources → pause gate → desired → D8 → insert) runs inside the
 * guild queue; phase B (publish, initial backfill) runs outside it.
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
