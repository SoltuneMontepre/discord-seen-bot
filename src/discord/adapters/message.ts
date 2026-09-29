import { MessageType } from "@discordjs/core";
import type { Signal } from "../../domain/signals.ts";
import { timestampOf } from "../../domain/snowflake.ts";

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
