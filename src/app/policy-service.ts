import type { AutoTrackPolicy, PolicyRepository } from "../db/policy-repository.ts";
import type { Policy } from "../domain/policy.ts";
import { nextPolicyState, type PolicyEvent } from "../domain/policy-state.ts";
import type { TargetSource } from "../domain/target-sources.ts";
import type { Snowflake } from "../domain/types.ts";
import type { AutoTrackCoordinator } from "./auto-track-coordinator.ts";
import type { ConfigAction, ConfigActor, ConfigAuthorizer } from "./config-authorizer.ts";
import type { GuildAutoTrackHealth } from "./guild-auto-track-health.ts";
import type { GuildQueue } from "./guild-queue.ts";
import type { MemberRoleIndex } from "./member-role-index.ts";
import type { MemberStateRebuilder } from "./member-state-rebuilder.ts";
import type { Clock, Logger } from "./ports.ts";
import type { TargetReconciler } from "./target-reconciler.ts";
import type { TargetResolverRegistry } from "./target-resolution.ts";

export type PolicyError =
  | "paused"
  | "over_limit"
  | "needs_role"
  | "everyone_role"
  | "invalid_name"
  | "not_found"
  | "invalid_state";

export type PolicyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PolicyError; detail?: { resolved: number; limit: number } };

export interface ChannelStatus {
  paused: boolean;
  resolved?: number;
  limit: number;
  overLimit: boolean;
}

const NAME_MAX = 100;
const fail = <T>(error: PolicyError): PolicyResult<T> => ({ ok: false, error });

/**
 * Policy CRUD (spec §7.3, §8.3, §12.3). Each public mutation is exactly one guild-queue task; inside
 * it only …InQueue methods and DB transactions run.
 * - Target-increasing changes need a healthy guild, an in-queue index extension and the D8 check.
 * - Target-decreasing changes always commit; their reconcile is skipped while paused and applied by
 *   the recovery reconcile.
 * There is no policy-count limit.
 */
export class PolicyService {
  private readonly deps: {
    policies: PolicyRepository;
    authorizer: ConfigAuthorizer;
    registry: TargetResolverRegistry;
    index: MemberRoleIndex;
    health: GuildAutoTrackHealth;
    queue: GuildQueue;
    rebuilder: MemberStateRebuilder;
    reconciler: TargetReconciler;
    coordinator: Pick<AutoTrackCoordinator, "pruneReferencedRolesInQueue">;
    policy: Pick<Policy, "autoTrackMaxTargets">;
    clock: Clock;
    logger: Logger;
  };

  constructor(deps: PolicyService["deps"]) {
    this.deps = deps;
  }

  async create(
    actor: ConfigActor,
    input: { channelId: Snowflake; name: string; roleId: Snowflake },
  ): Promise<PolicyResult<AutoTrackPolicy>> {
    const g = this.guildOf(actor, "policy.create", input.channelId);
    if (!g) return fail("not_found");
    const name = input.name.trim();
    if (!validName(name)) return fail("invalid_name");
    if (input.roleId === g) return fail("everyone_role");
    return this.deps.queue.run(g, async () => {
      const inc = await this.prepareIncreaseInQueue(g, input.channelId, [input.roleId], undefined);
      if (!inc.ok) return inc;
      const p = await this.deps.policies.create({
        guildId: g,
        channelId: input.channelId,
        name,
        roleIds: [input.roleId],
        actor: actor.userId,
        at: this.deps.clock.now(),
      });
      await this.afterCommitInQueue(g, p.channelId);
      return { ok: true as const, value: p };
    });
  }

  /** Replaces the role set. Auto re-enables only from auto_disabled_missing_role. */
  async saveRoles(
    actor: ConfigActor,
    policyId: number,
    roleIds: readonly Snowflake[],
  ): Promise<PolicyResult<AutoTrackPolicy>> {
    const g = this.guildOf(actor, "policy.edit");
    if (!g) return fail("not_found");
    const roles = [...new Set(roleIds)];
    if (roles.includes(g)) return fail("everyone_role");
    return this.withPolicy(g, policyId, async (p) => {
      const next = nextPolicyState(p.state, { type: "roles_saved", sourceCount: roles.length });
      if (!next.ok) return fail(next.reason === "needs_role" ? "needs_role" : "invalid_state");
      const increasing =
        next.state === "enabled" &&
        (p.state !== "enabled" || roles.some((r) => !p.roleIds.includes(r)));
      if (increasing) {
        const inc = await this.prepareIncreaseInQueue(g, p.channelId, roles, p.id);
        if (!inc.ok) return inc;
      }
      await this.deps.policies.saveRolesAndState(
        p.id,
        roles,
        next.state,
        actor.userId,
        this.deps.clock.now(),
      );
      await this.afterCommitInQueue(g, p.channelId);
      return this.reload(p.id);
    });
  }

  async setState(
    actor: ConfigActor,
    policyId: number,
    action: "disable" | "enable" | "keep_disabled",
  ): Promise<PolicyResult<AutoTrackPolicy>> {
    const g = this.guildOf(actor, "policy.edit");
    if (!g) return fail("not_found");
    return this.withPolicy(g, policyId, async (p) => {
      const event: PolicyEvent =
        action === "disable"
          ? { type: "user_disable" }
          : action === "enable"
            ? { type: "user_enable", sourceCount: p.roleIds.length }
            : { type: "keep_disabled" };
      const next = nextPolicyState(p.state, event);
      if (!next.ok) return fail(next.reason === "needs_role" ? "needs_role" : "invalid_state");
      if (next.state === p.state) return { ok: true as const, value: p };
      if (next.state === "enabled") {
        const inc = await this.prepareIncreaseInQueue(g, p.channelId, p.roleIds, p.id);
        if (!inc.ok) return inc;
      }
      await this.deps.policies.setState(p.id, next.state, actor.userId, this.deps.clock.now());
      await this.afterCommitInQueue(g, p.channelId);
      return this.reload(p.id);
    });
  }

  async rename(
    actor: ConfigActor,
    policyId: number,
    name: string,
  ): Promise<PolicyResult<AutoTrackPolicy>> {
    const g = this.guildOf(actor, "policy.edit");
    if (!g) return fail("not_found");
    const trimmed = name.trim();
    if (!validName(trimmed)) return fail("invalid_name");
    return this.withPolicy(g, policyId, async (p) => {
      await this.deps.policies.rename(p.id, trimmed, actor.userId, this.deps.clock.now());
      return this.reload(p.id);
    });
  }

  async delete(actor: ConfigActor, policyId: number): Promise<PolicyResult<void>> {
    const g = this.guildOf(actor, "policy.delete");
    if (!g) return fail("not_found");
    return this.withPolicy(g, policyId, async (p) => {
      await this.deps.policies.delete(p.id);
      await this.afterCommitInQueue(g, p.channelId);
      return { ok: true as const, value: undefined };
    });
  }

  /** Read-only status for /autotrack list (paused / resolved / over limit). */
  async channelStatus(guildId: Snowflake, channelId: Snowflake): Promise<ChannelStatus> {
    const limit = this.deps.policy.autoTrackMaxTargets;
    if (this.deps.health.isPaused(guildId)) return { paused: true, limit, overLimit: false };
    const roles = await this.deps.policies.enabledRoleIdsForChannel(channelId);
    const resolved = this.resolvedCount(guildId, roles);
    return { paused: false, resolved, limit, overLimit: resolved > limit };
  }

  // ------------------------------------------------------------------ internals

  private guildOf(
    actor: ConfigActor,
    action: ConfigAction,
    channelId?: Snowflake,
  ): Snowflake | undefined {
    const g = actor.guildId;
    if (!g) return undefined;
    const scope = channelId === undefined ? { guildId: g } : { guildId: g, channelId };
    return this.deps.authorizer.authorize(actor, action, scope).ok ? g : undefined;
  }

  /** One queue task; the policy must exist and belong to the actor's guild (tenant isolation). */
  private withPolicy<T>(
    guildId: Snowflake,
    policyId: number,
    fn: (p: AutoTrackPolicy) => Promise<PolicyResult<T>>,
  ): Promise<PolicyResult<T>> {
    return this.deps.queue.run(guildId, async () => {
      const p = await this.deps.policies.get(policyId);
      if (!p || p.guildId !== guildId) return fail<T>("not_found");
      return fn(p);
    });
  }

  private async reload(policyId: number): Promise<PolicyResult<AutoTrackPolicy>> {
    const p = await this.deps.policies.get(policyId);
    return p ? { ok: true, value: p } : fail("not_found");
  }

  /**
   * Healthy guild → extend the index for roles it lacks (in-queue rebuild) → D8 on the channel's
   * resulting enabled union (the changed policy with `roles`, plus the other enabled policies).
   */
  private async prepareIncreaseInQueue(
    guildId: Snowflake,
    channelId: Snowflake,
    roles: readonly Snowflake[],
    changedPolicyId: number | undefined,
  ): Promise<PolicyResult<never> | { ok: true }> {
    if (this.deps.health.isPaused(guildId)) return fail("paused");
    const others = await this.deps.policies.listForChannel(channelId, {
      offset: 0,
      limit: Math.max(1, await this.deps.policies.countForChannel(channelId)),
    });
    const union = new Set(roles);
    for (const p of others) {
      if (p.state === "enabled" && p.id !== changedPolicyId)
        for (const r of p.roleIds) union.add(r);
    }
    const known = this.deps.index.referencedRoles(guildId);
    const missing = [...union].filter((r) => !known.has(r));
    if (missing.length > 0) {
      const r = await this.deps.rebuilder.rebuildNowInQueue(guildId, "roles_grew", {
        extraReferencedRoleIds: missing,
        reconcile: false,
      });
      if (r !== "healthy") return fail("paused");
    }
    const resolved = this.resolvedCount(guildId, [...union]);
    const limit = this.deps.policy.autoTrackMaxTargets;
    if (resolved > limit) {
      await this.deps.coordinator.pruneReferencedRolesInQueue(guildId);
      return { ok: false, error: "over_limit", detail: { resolved, limit } };
    }
    return { ok: true };
  }

  /** Eligible (non-bot) members of the roles; the per-message author is not known here. */
  private resolvedCount(guildId: Snowflake, roles: readonly Snowflake[]): number {
    const sources = roles.map((roleId): TargetSource => ({ type: "role", roleId }));
    return this.deps.registry.desiredTargets(sources, { guildId, sourceAuthorId: "" }).length;
  }

  private async afterCommitInQueue(guildId: Snowflake, channelId: Snowflake): Promise<void> {
    await this.deps.reconciler.reconcileChannelInQueue(guildId, channelId);
    await this.deps.coordinator.pruneReferencedRolesInQueue(guildId);
  }
}

function validName(name: string): boolean {
  return name.length >= 1 && name.length <= NAME_MAX;
}
