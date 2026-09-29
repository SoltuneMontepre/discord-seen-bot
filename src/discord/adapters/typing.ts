import type { GatewayTypingStartDispatchData } from "@discordjs/core";
import type { Signal } from "../../domain/signals.ts";

/** TYPING_START.timestamp is unix SECONDS; converted to ms. Best-effort signal. */
export function typingToSignal(d: GatewayTypingStartDispatchData): Signal | null {
  if (!d.guild_id || d.member?.user?.bot) return null;
  return {
    t: "TYPING",
    guildId: d.guild_id,
    channelId: d.channel_id,
    userId: d.user_id,
    occurredAt: d.timestamp * 1000,
  };
}
