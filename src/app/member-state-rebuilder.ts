import pLimit from "p-limit";
import type { PolicyRepository } from "../db/policy-repository.ts";
import type { Repository } from "../db/repository.ts";
import type { RoleDeletionStore } from "../db/role-deletion.ts";
import type { Policy } from "../domain/policy.ts";
import type { Snowflake } from "../domain/types.ts";
import type { GuildAutoTrackHealth } from "./guild-auto-track-health.ts";
import type { GuildQueue } from "./guild-queue.ts";
import type { MemberRoleIndex } from "./member-role-index.ts";
import type { Clock, DiscordPort, GuildMemberRoles, Logger, Lookup } from "./ports.ts";
import type { DirtySink } from "./render-scheduler.ts";
import { isRoleDependent } from "./role-dependence.ts";
import type { TargetReconciler } from "./target-reconciler.ts";

export type RebuildReason = "guild_create" | "retry" | "roles_grew";

/** List Guild Members maximum page size. */
const MEMBER_PAGE_LIMIT = 1000;
const INTENT_HINT =
  "enable Server Members Intent for this app in the Developer Portal, or set ROLE_TARGETS_ENABLED=false";

class RebuildStepError extends Error {
  readonly code: number | undefined;
  constructor(step: string, failure: Extract<Lookup<unknown>, { ok: false }>) {
    super(`${step} failed (${failure.class})`);
    this.code = failure.code;
  }
}

/**
 * Member-state rebuild and recovery (spec §9.2). External entry points (`request…`) schedule keyed
 * guild-queue tasks and are never awaited by queue tasks; `rebuildNowInQueue` requires the caller
 * to own the guild's queue slot and never enqueues.
 */
export class MemberStateRebuilder {
  private readonly deps: {
    port: DiscordPort;
    policies: PolicyRepository;
    repo: Repository;
    roleDeletion: RoleDeletionStore;
    index: MemberRoleIndex;
    health: GuildAutoTrackHealth;
    queue: GuildQueue;
    reconciler: TargetReconciler;
    scheduler: Pick<DirtySink, "markDirty">;
    policy: Pick<Policy, "memberRebuildBackoffMs" | "memberRebuildSteadyMs" | "reconcileRetryMs">;
    clock: Clock;
    logger: Logger;
  };
  /** Global: one guild pages members at a time. Held only around pagination. */
  private readonly memberListing = pLimit(1);
  private readonly attempts = new Map<Snowflake, number>();
  private readonly timers = new Map<Snowflake, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(deps: MemberStateRebuilder["deps"]) {
    this.deps = deps;
  }

  // ------------------------------------------------------------------ external entry points

  requestRebuild(guildId: Snowflake, reason: "guild_create" | "retry"): void {
    if (this.disposed) return;
    this.deps.queue
      .runKeyed(guildId, "rebuild", async () => {
        await this.rebuildNowInQueue(guildId, reason);
      })
      .catch((err) => this.deps.logger.error({ guildId, err }, "member-state rebuild crashed"));
  }

  /** Index-only retry of the recovery reconcile (no REST). */
  requestRecoveryReconcile(guildId: Snowflake): void {
    if (this.disposed) return;
    this.deps.queue
      .runKeyed(guildId, "recovery-reconcile", async () => {
        if (this.deps.health.state(guildId) !== "reconciling") return;
        await this.reconcileAndResume(guildId, "retry");
      })
      .catch((err) => this.deps.logger.error({ guildId, err }, "recovery reconcile crashed"));
  }

  // ------------------------------------------------------------------ in-queue

  async rebuildNowInQueue(
    guildId: Snowflake,
    reason: RebuildReason,
    opts: { extraReferencedRoleIds?: readonly Snowflake[]; reconcile?: boolean } = {},
  ): Promise<"healthy" | "failed"> {
    this.deps.queue.assertInQueue(guildId);
    this.clearTimer(guildId);
    const extra = opts.extraReferencedRoleIds ?? [];
    if (extra.length === 0 && !(await this.needsRebuild(guildId))) {
      this.deps.index.setReferencedRoles(guildId, []);
      await this.markHealthy(guildId, reason);
      return "healthy";
    }
    // Extending a healthy guild's index (new policy role, newly mentioned role) is not a loss of
    // member state: the guild stays healthy (no pause notice); already-indexed roles stay valid.
    const extension = reason === "roles_grew" && !this.deps.health.isPaused(guildId);
    if (!extension) {
      this.deps.health.set(guildId, "rebuilding", { attempt: this.attempts.get(guildId) ?? 0 });
    }
    const before = this.membershipOf(guildId);
    let pruned = 0;
    try {
      pruned = await this.pruneDeletedRoles(guildId);
      const referenced = new Set([
        ...(await this.deps.policies.referencedRoleIds(guildId)),
        ...(await this.deps.repo.activeMessageRoleIds(guildId)),
        ...extra,
      ]);
      const members = await this.memberListing(() => this.listMembers(guildId, referenced));
      this.deps.index.setReferencedRoles(guildId, referenced);
      this.deps.index.replaceSnapshot(guildId, members);
    } catch (err) {
      this.fail(guildId, err);
      return "failed";
    }
    if (extension) {
      // Member events queued behind this task are diffed against the NEW snapshot, so changes
      // that happened during the listing (or offline role prunes) must be reconciled here.
      if (pruned > 0 || this.membershipChanged(guildId, before)) {
        try {
          await this.deps.reconciler.reconcileGuildInQueue(guildId);
        } catch (err) {
          this.fail(guildId, err);
          return "failed";
        }
      }
      return "healthy";
    }
    if (opts.reconcile === false) {
      await this.markHealthy(guildId, reason);
      return "healthy";
    }
    return this.reconcileAndResume(guildId, reason);
  }

  /** Enabled role policies OR active auto trackings with a message role source. */
  async needsRebuild(guildId: Snowflake): Promise<boolean> {
    return (
      (await this.deps.policies.referencedRoleIds(guildId)).length > 0 ||
      (await this.deps.repo.activeMessageRoleIds(guildId)).length > 0
    );
  }

  /** Non-blocking refresh of the guild's role-dependent active auto cards (resume, grace). */
  async refreshRoleDependentCards(guildId: Snowflake): Promise<void> {
    for (const t of await this.deps.repo.listActiveAuto({ guildId })) {
      if (isRoleDependent(await this.deps.reconciler.sourcesFor(t))) {
        this.deps.scheduler.markDirty(t.id);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ------------------------------------------------------------------ steps

  /** Current indexed membership per referenced role (user ids), to detect snapshot differences. */
  private membershipOf(guildId: Snowflake): Map<Snowflake, Set<Snowflake>> {
    const out = new Map<Snowflake, Set<Snowflake>>();
    for (const roleId of this.deps.index.referencedRoles(guildId)) {
      out.set(roleId, new Set(this.deps.index.membersOf(guildId, roleId).map((m) => m.userId)));
    }
    return out;
  }

  private membershipChanged(
    guildId: Snowflake,
    before: ReadonlyMap<Snowflake, ReadonlySet<Snowflake>>,
  ): boolean {
    const after = this.membershipOf(guildId);
    for (const [roleId, users] of before) {
      const now = after.get(roleId);
      if (!now || now.size !== users.size) return true;
      for (const u of users) if (!now.has(u)) return true;
    }
    return false;
  }

  /** Step 2: prune roles referenced by any policy or active message source but gone from the guild. */
  private async pruneDeletedRoles(guildId: Snowflake): Promise<number> {
    const roles = await this.deps.port.getGuildRoleIds(guildId);
    if (!roles.ok) throw new RebuildStepError("get guild roles", roles);
    const existing = new Set(roles.value);
    const referenced = new Set([
      ...(await this.deps.policies.allRoleIds(guildId)),
      ...(await this.deps.repo.activeMessageRoleIds(guildId)),
    ]);
    const at = this.deps.clock.now();
    let pruned = 0;
    for (const roleId of referenced) {
      if (existing.has(roleId)) continue;
      await this.deps.roleDeletion.apply(guildId, roleId, at);
      this.deps.index.dropRole(guildId, roleId);
      this.deps.logger.info({ guildId, roleId }, "pruned role deleted while offline");
      pruned += 1;
    }
    return pruned;
  }

  /** Step 3: page every member; keep only those holding a referenced role (never a directory). */
  private async listMembers(
    guildId: Snowflake,
    referenced: ReadonlySet<Snowflake>,
  ): Promise<GuildMemberRoles[]> {
    const kept: GuildMemberRoles[] = [];
    let after: Snowflake | undefined;
    for (;;) {
      const page = await this.deps.port.listGuildMembers(guildId, after, MEMBER_PAGE_LIMIT);
      if (!page.ok) throw new RebuildStepError("list guild members", page);
      for (const m of page.value) {
        if (m.roleIds.some((r) => referenced.has(r))) kept.push(m);
        if (after === undefined || BigInt(m.userId) > BigInt(after)) after = m.userId;
      }
      if (page.value.length < MEMBER_PAGE_LIMIT) return kept;
    }
  }

  /** Steps 4–5. A DB failure keeps `reconciling` and retries index-only after reconcileRetryMs. */
  private async reconcileAndResume(
    guildId: Snowflake,
    reason: RebuildReason,
  ): Promise<"healthy" | "failed"> {
    this.deps.health.set(guildId, "reconciling", { attempt: this.attempts.get(guildId) ?? 0 });
    try {
      await this.deps.reconciler.reconcileGuildInQueue(guildId, { ignorePause: true });
    } catch (err) {
      const nextRetryInMs = this.deps.policy.reconcileRetryMs;
      this.deps.logger.error(
        { guildId, err, nextRetryInMs },
        "auto-track recovery reconcile failed; still paused",
      );
      this.schedule(guildId, nextRetryInMs, () => this.requestRecoveryReconcile(guildId));
      return "failed";
    }
    await this.markHealthy(guildId, reason);
    return "healthy";
  }

  private async markHealthy(guildId: Snowflake, reason: RebuildReason): Promise<void> {
    const wasPaused = this.deps.health.isPaused(guildId);
    const since = this.deps.health.pausedSince(guildId);
    const attempt = this.attempts.get(guildId) ?? 0;
    this.attempts.delete(guildId);
    this.clearTimer(guildId);
    this.deps.health.set(guildId, "healthy");
    if (!wasPaused) return;
    if (reason === "roles_grew") {
      // Extension of a healthy guild's index (policy change, newly mentioned role): not a resume.
      this.deps.logger.debug({ guildId }, "member state extended for new referenced roles");
      return;
    }
    this.deps.logger.info(
      {
        guildId,
        reason,
        attempt,
        pausedForMs: since === undefined ? 0 : this.deps.clock.now() - since,
      },
      "auto-track resumed",
    );
    try {
      await this.refreshRoleDependentCards(guildId);
    } catch (err) {
      this.deps.logger.warn({ guildId, err }, "card refresh after resume failed");
    }
  }

  /** Step 6. */
  private fail(guildId: Snowflake, err: unknown): void {
    const attempt = (this.attempts.get(guildId) ?? 0) + 1;
    this.attempts.set(guildId, attempt);
    const backoff = this.deps.policy.memberRebuildBackoffMs;
    const nextRetryInMs = backoff[attempt - 1] ?? this.deps.policy.memberRebuildSteadyMs;
    const code = err instanceof RebuildStepError ? err.code : undefined;
    const reason = err instanceof Error ? err.message : String(err);
    this.deps.health.set(guildId, "failed", {
      reason,
      attempt,
      nextRetryInMs,
      ...(code === undefined ? {} : { code }),
    });
    const forbidden = code === 403 || code === 50001;
    this.deps.logger.warn(
      {
        guildId,
        reason,
        code,
        attempt,
        nextRetryInMs,
        ...(forbidden ? { hint: INTENT_HINT } : {}),
        ...(err instanceof RebuildStepError ? {} : { err }),
      },
      "auto-track paused",
    );
    this.schedule(guildId, nextRetryInMs, () => this.requestRebuild(guildId, "retry"));
  }

  private schedule(guildId: Snowflake, ms: number, fn: () => void): void {
    this.clearTimer(guildId);
    if (this.disposed) return;
    this.timers.set(
      guildId,
      setTimeout(() => {
        this.timers.delete(guildId);
        fn();
      }, ms),
    );
  }

  private clearTimer(guildId: Snowflake): void {
    clearTimeout(this.timers.get(guildId));
    this.timers.delete(guildId);
  }
}
