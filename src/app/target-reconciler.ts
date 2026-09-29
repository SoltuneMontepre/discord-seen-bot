import type { PolicyRepository } from "../db/policy-repository.ts";
import type { Repository } from "../db/repository.ts";
import type { Policy } from "../domain/policy.ts";
import type { TargetSource } from "../domain/target-sources.ts";
import type { Snowflake, TrackedMessage } from "../domain/types.ts";
import type { BackfillQueue } from "./backfill-queue.ts";
import type { GuildAutoTrackHealth } from "./guild-auto-track-health.ts";
import type { GuildQueue } from "./guild-queue.ts";
import type { Clock, Logger } from "./ports.ts";
import type { DirtySink } from "./render-scheduler.ts";
import { isRoleDependent } from "./role-dependence.ts";
import type { TargetResolverRegistry } from "./target-resolution.ts";

export type ReconcileOutcome =
  | "skipped_paused"
  | "inactive"
  | "unchanged"
  | "changed"
  | "stopped"
  | "limit_stopped";

/** D4: channel policies apply only to exact GUILD_TEXT / GUILD_ANNOUNCEMENT channels. */
const POLICY_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  0, // ChannelType.GuildText
  5, // ChannelType.GuildAnnouncement
]);

export interface ReconcileOptions {
  /**
   * Recovery reconcile only (spec §9.2 step 4): the guild is `reconciling` (paused) but the index
   * was just rebuilt, so role-dependent diffs are applied.
   */
  ignorePause?: boolean;
}

/**
 * Desired set → D8 limit → one-transaction diff (spec §6.2). All mutating methods require the
 * caller to own the guild's queue slot and never enqueue; hand-offs are non-blocking.
 */
export class TargetReconciler {
  private readonly deps: {
    features: { roleTargets: boolean };
    repo: Repository;
    policies: PolicyRepository;
    registry: TargetResolverRegistry;
    /** Present only when role targets are on. */
    health: GuildAutoTrackHealth | undefined;
    queue: GuildQueue;
    scheduler: Pick<DirtySink, "markDirty">;
    backfill: Pick<BackfillQueue, "enqueue">;
    policy: Pick<Policy, "autoTrackMaxTargets">;
    clock: Clock;
    logger: Logger;
  };

  constructor(deps: TargetReconciler["deps"]) {
    this.deps = deps;
  }

  /** Effective sources (spec §6.1): stored sources (flag-filtered) ∪ live exact-channel policy roles. */
  async sourcesFor(t: TrackedMessage): Promise<TargetSource[]> {
    const roleTargets = this.deps.features.roleTargets;
    const stored = (await this.deps.repo.listTrackingSources(t.id)).filter(
      (s) => roleTargets || s.type === "user",
    );
    if (!roleTargets || t.channelType === null || !POLICY_CHANNEL_TYPES.has(t.channelType)) {
      return stored;
    }
    const have = new Set(stored.flatMap((s) => (s.type === "role" ? [s.roleId] : [])));
    const policyRoles = (await this.deps.policies.enabledRoleIdsForChannel(t.channelId))
      .filter((r) => !have.has(r))
      .map((roleId): TargetSource => ({ type: "role", roleId }));
    return [...stored, ...policyRoles];
  }

  /** Spec §9.3: auto ∧ active ∧ guild paused ∧ role-dependent. Read-only; usable outside the queue. */
  async pauseNoticeApplies(t: TrackedMessage): Promise<boolean> {
    if (t.origin !== "auto" || t.stoppedAt !== null || !this.isPaused(t.guildId)) return false;
    return isRoleDependent(await this.sourcesFor(t));
  }

  async reconcileInQueue(
    trackedId: number,
    opts: ReconcileOptions = {},
  ): Promise<ReconcileOutcome> {
    const t = await this.deps.repo.getTracked(trackedId);
    if (!t || t.stoppedAt !== null || t.origin !== "auto") return "inactive";
    this.deps.queue.assertInQueue(t.guildId);
    const sources = await this.sourcesFor(t);
    if (!opts.ignorePause && isRoleDependent(sources) && this.isPaused(t.guildId)) {
      return "skipped_paused";
    }
    const desired = this.deps.registry.desiredTargets(sources, {
      guildId: t.guildId,
      sourceAuthorId: t.sourceAuthorId,
    });
    const at = this.deps.clock.now();
    const limit = this.deps.policy.autoTrackMaxTargets;
    if (desired.length > limit) {
      if (!(await this.deps.repo.stopAuto(t.id, "target_limit_exceeded", at))) return "inactive";
      this.deps.logger.warn(
        { trackedId: t.id, guildId: t.guildId, resolved: desired.length, limit },
        "auto tracking stopped: too many eligible members",
      );
      this.deps.scheduler.markDirty(t.id);
      return "limit_stopped";
    }
    const r = await this.deps.repo.reconcileAutoTargets(t.id, desired, at);
    switch (r.status) {
      case "inactive":
      case "unchanged":
        return r.status;
      case "stopped":
        this.deps.scheduler.markDirty(t.id);
        return "stopped";
      case "changed":
        this.deps.scheduler.markDirty(t.id);
        if (r.added.length > 0) this.deps.backfill.enqueue(t.id, r.added);
        return "changed";
    }
  }

  async reconcileChannelInQueue(
    guildId: Snowflake,
    channelId: Snowflake,
    opts: ReconcileOptions = {},
  ): Promise<void> {
    this.deps.queue.assertInQueue(guildId);
    const ts = await this.deps.repo.listActiveAuto({ guildId, channelIds: [channelId] });
    for (const t of ts) await this.reconcileInQueue(t.id, opts);
  }

  async reconcileGuildInQueue(guildId: Snowflake, opts: ReconcileOptions = {}): Promise<void> {
    this.deps.queue.assertInQueue(guildId);
    for (const t of await this.deps.repo.listActiveAuto({ guildId })) {
      await this.reconcileInQueue(t.id, opts);
    }
  }

  private isPaused(guildId: Snowflake): boolean {
    return this.deps.health?.isPaused(guildId) ?? false;
  }
}
