import type { MemberStateEvent } from "../../domain/target-sources.ts";

/** GUILD_MEMBER_ADD / GUILD_MEMBER_UPDATE (GUILD_MEMBERS intent). Ids and role ids only. */
export function memberUpsertToEvent(d: {
  guild_id?: string;
  user?: { id: string; bot?: boolean };
  roles: readonly string[];
}): MemberStateEvent | null {
  if (!d.guild_id || !d.user) return null;
  return {
    t: "member_upsert",
    guildId: d.guild_id,
    userId: d.user.id,
    roleIds: [...d.roles],
    bot: d.user.bot === true,
  };
}

export function memberRemoveToEvent(d: {
  guild_id?: string;
  user?: { id: string };
}): MemberStateEvent | null {
  if (!d.guild_id || !d.user) return null;
  return { t: "member_remove", guildId: d.guild_id, userId: d.user.id };
}

export function roleDeleteToEvent(d: { guild_id: string; role_id: string }): MemberStateEvent {
  return { t: "role_delete", guildId: d.guild_id, roleId: d.role_id };
}

export function guildCreateToEvent(d: { id: string }): MemberStateEvent {
  return { t: "guild_available", guildId: d.id };
}

/** Outage only; a removal is handled by the GUILD_REMOVED lifecycle path. */
export function guildDeleteToMemberEvent(d: {
  id: string;
  unavailable?: boolean;
}): MemberStateEvent | null {
  return d.unavailable ? { t: "guild_unavailable", guildId: d.id } : null;
}
