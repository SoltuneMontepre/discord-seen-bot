import type {
  GatewayChannelDeleteDispatchData,
  GatewayGuildDeleteDispatchData,
  GatewayMessageDeleteBulkDispatchData,
  GatewayMessageDeleteDispatchData,
  GatewayThreadDeleteDispatchData,
  GatewayThreadUpdateDispatchData,
} from "@discordjs/core";
import type { Signal } from "../../domain/signals.ts";

export function messageDeleteToSignal(d: GatewayMessageDeleteDispatchData): Signal | null {
  if (!d.guild_id) return null;
  return { t: "MESSAGES_DELETED", channelId: d.channel_id, messageIds: [d.id] };
}

export function messageDeleteBulkToSignal(d: GatewayMessageDeleteBulkDispatchData): Signal | null {
  if (!d.guild_id) return null;
  return { t: "MESSAGES_DELETED", channelId: d.channel_id, messageIds: [...d.ids] };
}

export function channelDeleteToSignal(d: GatewayChannelDeleteDispatchData): Signal {
  return { t: "CHANNEL_DELETED", channelId: d.id };
}

export function threadDeleteToSignal(d: GatewayThreadDeleteDispatchData): Signal {
  return { t: "CHANNEL_DELETED", channelId: d.id };
}

/** Any update of a non-archived thread re-arms deferred renders (hash check prevents no-op edits). */
export function threadUpdateToSignal(d: GatewayThreadUpdateDispatchData): Signal | null {
  if (d.thread_metadata?.archived) return null;
  return { t: "THREAD_UNARCHIVED", threadId: d.id };
}

/** `unavailable` set = outage, not removal. */
export function guildDeleteToSignal(d: GatewayGuildDeleteDispatchData): Signal | null {
  if (d.unavailable) return null;
  return { t: "GUILD_REMOVED", guildId: d.id };
}
