import type {
  GatewayMessageReactionAddDispatchData,
  GatewayMessageReactionRemoveAllDispatchData,
  GatewayMessageReactionRemoveDispatchData,
  GatewayMessageReactionRemoveEmojiDispatchData,
} from "@discordjs/core";
import { reactionKey, type Signal } from "../../domain/signals.ts";

/** "<custom emoji id>" or "<unicode name>" — stable identity for an emoji. */
export function emojiKeyOf(emoji: { id: string | null; name: string | null }): string | null {
  return emoji.id ?? emoji.name ?? null;
}

/** REST path form: "name:id" for custom emoji, the unicode character otherwise. */
export function apiEmojiOf(emoji: { id: string | null; name: string | null }): string | null {
  if (emoji.id) return `${emoji.name ?? "_"}:${emoji.id}`;
  return emoji.name ?? null;
}

function typeOf(d: { type?: number; burst?: boolean }): 0 | 1 {
  if (d.type === 1 || d.type === 0) return d.type;
  return d.burst ? 1 : 0;
}

/** Reactions carry no event time; the signal deliberately has no occurredAt. */
export function reactionAddToSignal(d: GatewayMessageReactionAddDispatchData): Signal | null {
  if (!d.guild_id || d.member?.user?.bot) return null;
  const key = emojiKeyOf(d.emoji);
  if (!key) return null;
  return {
    t: "REACTION_ADD",
    guildId: d.guild_id,
    channelId: d.channel_id,
    messageId: d.message_id,
    userId: d.user_id,
    reactionKey: reactionKey(key, typeOf(d)),
  };
}

/** No member field on REMOVE; harmless because only existing target rows are deleted. */
export function reactionRemoveToSignal(d: GatewayMessageReactionRemoveDispatchData): Signal | null {
  if (!d.guild_id) return null;
  const key = emojiKeyOf(d.emoji);
  if (!key) return null;
  return {
    t: "REACTION_REMOVE",
    guildId: d.guild_id,
    channelId: d.channel_id,
    messageId: d.message_id,
    userId: d.user_id,
    reactionKey: reactionKey(key, typeOf(d)),
  };
}

export function reactionRemoveAllToSignal(
  d: GatewayMessageReactionRemoveAllDispatchData,
): Signal | null {
  if (!d.guild_id) return null;
  return { t: "REACTION_REMOVE_ALL", channelId: d.channel_id, messageId: d.message_id };
}

export function reactionRemoveEmojiToSignal(
  d: GatewayMessageReactionRemoveEmojiDispatchData,
): Signal | null {
  if (!d.guild_id) return null;
  const key = emojiKeyOf(d.emoji);
  if (!key) return null;
  return {
    t: "REACTION_REMOVE_EMOJI",
    channelId: d.channel_id,
    messageId: d.message_id,
    emojiKey: key,
  };
}
