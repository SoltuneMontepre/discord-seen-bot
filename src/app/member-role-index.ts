import type { Snowflake } from "../domain/types.ts";
import type { ResolvedTarget } from "./target-resolution.ts";

interface IndexedMember {
  roles: Set<Snowflake>;
  bot: boolean;
}

interface GuildIndex {
  referenced: Set<Snowflake>;
  members: Map<Snowflake, IndexedMember>;
  byRole: Map<Snowflake, Set<Snowflake>>;
}

/**
 * In-memory referenced-role → members map (spec §9). Only roles referenced by an enabled policy or
 * an active auto tracking are kept, and only members holding one of them. Never persisted.
 */
export class MemberRoleIndex {
  private readonly guilds = new Map<Snowflake, GuildIndex>();

  /**
   * Replaces the referenced-role set with a value computed from source of truth.
   * SHRINK: roles no longer referenced are discarded from every member; members left with no
   *         referenced role are deleted. GROW: new roles start with NO members. Only a rebuild
   *         snapshot may populate them (never fabricate membership).
   */
  setReferencedRoles(
    guildId: Snowflake,
    roleIds: Iterable<Snowflake>,
  ): { droppedRoleIds: Snowflake[]; addedRoleIds: Snowflake[] } {
    const g = this.guild(guildId);
    const next = new Set(roleIds);
    const droppedRoleIds = [...g.referenced].filter((r) => !next.has(r));
    const addedRoleIds = [...next].filter((r) => !g.referenced.has(r));
    for (const r of droppedRoleIds) this.dropRole(guildId, r);
    for (const r of addedRoleIds) {
      g.referenced.add(r);
      g.byRole.set(r, new Set());
    }
    return { droppedRoleIds, addedRoleIds };
  }

  referencedRoles(guildId: Snowflake): ReadonlySet<Snowflake> {
    return this.guilds.get(guildId)?.referenced ?? new Set();
  }

  /** Replaces all membership from a REST snapshot, keeping referenced roles only. */
  replaceSnapshot(
    guildId: Snowflake,
    members: readonly { userId: Snowflake; roleIds: readonly Snowflake[]; bot: boolean }[],
  ): void {
    const g = this.guild(guildId);
    g.members.clear();
    for (const r of g.referenced) g.byRole.set(r, new Set());
    for (const m of members) this.write(g, m.userId, m.roleIds, m.bot);
  }

  /** Returns the referenced roles whose membership changed for this user (old Δ new). */
  upsert(
    guildId: Snowflake,
    userId: Snowflake,
    roleIds: readonly Snowflake[],
    bot: boolean,
  ): { changedRoleIds: Snowflake[] } {
    const g = this.guilds.get(guildId);
    if (!g) return { changedRoleIds: [] };
    const before = g.members.get(userId)?.roles ?? new Set<Snowflake>();
    const after = this.write(g, userId, roleIds, bot);
    const changedRoleIds = [
      ...[...before].filter((r) => !after.has(r)),
      ...[...after].filter((r) => !before.has(r)),
    ];
    return { changedRoleIds };
  }

  remove(guildId: Snowflake, userId: Snowflake): { hadRoleIds: Snowflake[] } {
    const g = this.guilds.get(guildId);
    const m = g?.members.get(userId);
    if (!g || !m) return { hadRoleIds: [] };
    this.unlink(g, userId, m);
    return { hadRoleIds: [...m.roles] };
  }

  /** The role no longer exists (or is no longer referenced): forget it everywhere. */
  dropRole(guildId: Snowflake, roleId: Snowflake): void {
    const g = this.guilds.get(guildId);
    if (!g) return;
    for (const userId of g.byRole.get(roleId) ?? []) {
      const m = g.members.get(userId);
      if (!m) continue;
      m.roles.delete(roleId);
      if (m.roles.size === 0) g.members.delete(userId);
    }
    g.byRole.delete(roleId);
    g.referenced.delete(roleId);
  }

  membersOf(guildId: Snowflake, roleId: Snowflake): ResolvedTarget[] {
    const g = this.guilds.get(guildId);
    const users = g?.byRole.get(roleId);
    if (!g || !users) return [];
    return [...users].map((userId) => ({ userId, bot: g.members.get(userId)?.bot }));
  }

  memberCount(guildId: Snowflake): number {
    return this.guilds.get(guildId)?.members.size ?? 0;
  }

  guildIds(): Iterable<Snowflake> {
    return this.guilds.keys();
  }

  clear(guildId: Snowflake): void {
    this.guilds.delete(guildId);
  }

  private guild(guildId: Snowflake): GuildIndex {
    let g = this.guilds.get(guildId);
    if (!g) {
      g = { referenced: new Set(), members: new Map(), byRole: new Map() };
      this.guilds.set(guildId, g);
    }
    return g;
  }

  /** Stores the user's referenced roles (deleting the member if none); returns the stored set. */
  private write(
    g: GuildIndex,
    userId: Snowflake,
    roleIds: readonly Snowflake[],
    bot: boolean,
  ): Set<Snowflake> {
    const existing = g.members.get(userId);
    if (existing) this.unlink(g, userId, existing);
    const roles = new Set(roleIds.filter((r) => g.referenced.has(r)));
    if (roles.size === 0) return roles;
    g.members.set(userId, { roles, bot });
    for (const r of roles) g.byRole.get(r)?.add(userId);
    return roles;
  }

  private unlink(g: GuildIndex, userId: Snowflake, m: IndexedMember): void {
    for (const r of m.roles) g.byRole.get(r)?.delete(userId);
    g.members.delete(userId);
  }
}
