import type { Snowflake, UnixMs } from "./types.ts";

/** Normalized gateway/history input. Produced by pure adapters; no content, ever. */
export type Signal =
  | {
      t: "MESSAGE";
      /** null for history pages (REST messages carry no guild_id); never used for matching. */
      guildId: Snowflake | null;
      channelId: Snowflake;
      messageId: Snowflake;
      authorId: Snowflake;
      occurredAt: UnixMs;
      replyToMessageId?: Snowflake;
    }
  | {
      t: "REACTION_ADD" | "REACTION_REMOVE";
      guildId: Snowflake;
      channelId: Snowflake;
      messageId: Snowflake;
      userId: Snowflake;
      reactionKey: string;
    }
  | { t: "REACTION_REMOVE_ALL"; channelId: Snowflake; messageId: Snowflake }
  | { t: "REACTION_REMOVE_EMOJI"; channelId: Snowflake; messageId: Snowflake; emojiKey: string }
  | {
      t: "TYPING";
      guildId: Snowflake;
      channelId: Snowflake;
      userId: Snowflake;
      occurredAt: UnixMs;
    }
  | { t: "MESSAGES_DELETED"; channelId: Snowflake; messageIds: Snowflake[] }
  | { t: "CHANNEL_DELETED"; channelId: Snowflake }
  | { t: "THREAD_UNARCHIVED"; threadId: Snowflake }
  | { t: "GUILD_REMOVED"; guildId: Snowflake };

/** "<emojiId or unicode name>|<0 normal | 1 burst>" */
export function reactionKey(emojiKey: string, type: 0 | 1): string {
  return `${emojiKey}|${type}`;
}

export function reactionKeysForEmoji(emojiKey: string): [string, string] {
  return [reactionKey(emojiKey, 0), reactionKey(emojiKey, 1)];
}
