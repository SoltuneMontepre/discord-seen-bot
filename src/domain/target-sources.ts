import type { Snowflake } from "./types.ts";

/**
 * Target Source model (spec §5).
 * - "user": ExplicitUser — fixed; from the OUTER message at MESSAGE_CREATE; never consults member state.
 * - "role": MentionedRole (frozen reference) or ChannelPolicy role (live) — membership is dynamic.
 * Provenance is where a source is stored (tracking_sources vs policy tables), not its type.
 */
export type TargetSource =
  | { type: "user"; userId: Snowflake }
  | { type: "role"; roleId: Snowflake };
export type TargetSourceType = TargetSource["type"];

/** A live top-level MESSAGE_CREATE that may start an auto tracking (ids only; no content). */
export interface AutoTrackCandidate {
  guildId: Snowflake;
  channelId: Snowflake;
  channelType: number;
  messageId: Snowflake;
  authorId: Snowflake;
  /** Outer-message explicit user mentions (bots, author and forward-ambiguous ids removed; flag-filtered). */
  explicitUserIds: Snowflake[];
  /** Outer-message role mentions (@everyone and forward-ambiguous ids removed; flag-filtered). */
  mentionedRoleIds: Snowflake[];
}

/** Normalized member/role/guild gateway events for the role-state subsystem. */
export type MemberStateEvent =
  | {
      t: "member_upsert";
      guildId: Snowflake;
      userId: Snowflake;
      roleIds: Snowflake[];
      bot: boolean;
    }
  | { t: "member_remove"; guildId: Snowflake; userId: Snowflake }
  | { t: "role_delete"; guildId: Snowflake; roleId: Snowflake }
  | { t: "guild_available"; guildId: Snowflake }
  | { t: "guild_unavailable"; guildId: Snowflake }
  | { t: "guild_removed"; guildId: Snowflake };
