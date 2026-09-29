import { MessageFlags, MessageReferenceType, MessageType } from "@discordjs/core";
import type { Signal } from "../../domain/signals.ts";
import { timestampOf } from "../../domain/snowflake.ts";
import type { AutoTrackCandidate } from "../../domain/target-sources.ts";
import { SUPPORTED_CHANNEL_TYPES } from "../permissions.ts";

/** Minimal shape shared by gateway MESSAGE_CREATE payloads and REST history messages. */
export interface MessageLike {
  id: string;
  channel_id: string;
  guild_id?: string;
  type: number;
  author: { id: string; bot?: boolean };
  webhook_id?: string;
  message_reference?: { message_id?: string };
}

const TRACKABLE_TYPES = new Set<number>([MessageType.Default, MessageType.Reply]);

/**
 * MESSAGE_CREATE / history message → MESSAGE signal. Reads ids and metadata only (no content —
 * the bot has no Message Content intent). Drops bots, webhooks and system messages.
 * `requireGuild`: gateway messages without guild_id are DMs and are ignored.
 */
export function messageToSignal(m: MessageLike, requireGuild: boolean): Signal | null {
  if (requireGuild && !m.guild_id) return null;
  if (m.author.bot || m.webhook_id) return null;
  if (!TRACKABLE_TYPES.has(m.type)) return null;
  const replyTo = m.type === MessageType.Reply ? m.message_reference?.message_id : undefined;
  return {
    t: "MESSAGE",
    guildId: m.guild_id ?? null,
    channelId: m.channel_id,
    messageId: m.id,
    authorId: m.author.id,
    occurredAt: timestampOf(m.id),
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
  };
}

/** Live MESSAGE_CREATE fields the auto-track trigger reads (ids and metadata only). */
export interface MessageCreateLike extends MessageLike {
  channel_type?: number;
  flags?: number;
  mentions?: readonly { id: string; bot?: boolean }[];
  mention_roles?: readonly string[];
  message_reference?: { message_id?: string; type?: number };
  message_snapshots?: readonly {
    message: { mentions?: readonly { id: string }[]; mention_roles?: readonly string[] };
  }[];
}

/**
 * Live MESSAGE_CREATE → auto-track candidate (spec §8.1, E3–E5), or null when the message cannot
 * trigger. Never reads content. For forwards, snapshot mention ids are inspected only to drop
 * ambiguous outer ids; they are discarded before returning and never become sources.
 */
export function messageToAutoTrackCandidate(
  d: MessageCreateLike,
  flags: { mentionAutoTrack: boolean; roleTargets: boolean },
): AutoTrackCandidate | null {
  if (!d.guild_id || d.type !== MessageType.Default) return null;
  if (d.author.bot || d.webhook_id) return null;
  if (d.channel_type === undefined || !SUPPORTED_CHANNEL_TYPES.has(d.channel_type)) return null;

  const forward =
    d.message_reference?.type === MessageReferenceType.Forward ||
    ((d.flags ?? 0) & MessageFlags.HasSnapshot) !== 0;
  const ambiguous = new Set<string>();
  if (forward) {
    for (const s of d.message_snapshots ?? []) {
      for (const u of s.message.mentions ?? []) ambiguous.add(u.id);
      for (const r of s.message.mention_roles ?? []) ambiguous.add(r);
    }
  }

  const guildId = d.guild_id;
  const authorId = d.author.id;
  const users = flags.mentionAutoTrack
    ? (d.mentions ?? [])
        .filter((u) => !u.bot && u.id !== authorId && !ambiguous.has(u.id))
        .map((u) => u.id)
    : [];
  const roles =
    flags.mentionAutoTrack && flags.roleTargets
      ? (d.mention_roles ?? []).filter((r) => r !== guildId && !ambiguous.has(r))
      : [];
  return {
    guildId,
    channelId: d.channel_id,
    channelType: d.channel_type,
    messageId: d.id,
    authorId,
    explicitUserIds: [...new Set(users)],
    mentionedRoleIds: [...new Set(roles)],
  };
}
