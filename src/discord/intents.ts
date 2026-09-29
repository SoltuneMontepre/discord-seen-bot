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

/**
 * M9: GUILD_MEMBERS (privileged) is requested only when role targets are enabled.
 * The mention flag never changes intents; mention ids arrive via GUILD_MESSAGES without Message Content.
 */
export function buildIntents(features: {
  roleTargets: boolean;
  mentionAutoTrack?: boolean;
}): number {
  return features.roleTargets ? INTENTS | GatewayIntentBits.GuildMembers : INTENTS;
}

/** Never MESSAGE_CONTENT or GUILD_PRESENCES; GUILD_MEMBERS only with role targets enabled. */
export function assertAllowedIntents(intents: number, features: { roleTargets: boolean }): void {
  if ((intents & GatewayIntentBits.MessageContent) !== 0) {
    throw new Error("MESSAGE_CONTENT intent is never allowed for this bot");
  }
  if ((intents & GatewayIntentBits.GuildPresences) !== 0) {
    throw new Error("GUILD_PRESENCES intent is never allowed for this bot");
  }
  if (!features.roleTargets && (intents & GatewayIntentBits.GuildMembers) !== 0) {
    throw new Error("GUILD_MEMBERS intent is only allowed when ROLE_TARGETS_ENABLED=true");
  }
}
