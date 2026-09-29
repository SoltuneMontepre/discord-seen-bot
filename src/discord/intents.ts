import { GatewayIntentBits } from "@discordjs/core";

/** Minimal intents: 1 + 512 + 1024 + 2048 = 3585. No privileged intents. */
export const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.GuildMessageReactions |
  GatewayIntentBits.GuildMessageTyping;

export const PRIVILEGED_INTENTS =
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildPresences |
  GatewayIntentBits.MessageContent;

export function assertNoPrivilegedIntents(intents: number): void {
  if ((intents & PRIVILEGED_INTENTS) !== 0) {
    throw new Error("Privileged gateway intents are not allowed for this bot");
  }
}
