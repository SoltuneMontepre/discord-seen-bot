import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type RESTPostAPIContextMenuApplicationCommandsJSONBody,
  type RESTPutAPIApplicationCommandsJSONBody,
  type RESTPutAPIApplicationGuildCommandsJSONBody,
} from "@discordjs/core";
import { TRACK_SEEN_COMMAND_NAME } from "./interactions/track-seen.ts";

/**
 * Apps → Track Seen. No default_member_permissions: anyone who can use app commands may start
 * tracking; server admins restrict it via Server Settings → Integrations.
 */
export const trackSeenCommand: RESTPostAPIContextMenuApplicationCommandsJSONBody = {
  name: TRACK_SEEN_COMMAND_NAME,
  type: ApplicationCommandType.Message,
  integration_types: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild],
};

export const AUTOTRACK_COMMAND_NAME = "autotrack";
/** D4: policies live on exact text / announcement channels only. */
const POLICY_CHANNEL_TYPES: (ChannelType.GuildText | ChannelType.GuildAnnouncement)[] = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
];

/**
 * /autotrack (M9, spec §12.1). Always registered (D11); no default_member_permissions (any guild
 * member configures in M9, restrictable via Integrations); guild only.
 */
export const autotrackCommand: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: AUTOTRACK_COMMAND_NAME,
  description: "Configure role-based auto-tracking for a channel",
  type: ApplicationCommandType.ChatInput,
  integration_types: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild],
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "create",
      description: "Create an auto-track policy for a channel",
      options: [
        {
          type: ApplicationCommandOptionType.Channel,
          name: "channel",
          description: "Text or announcement channel",
          required: true,
          channel_types: POLICY_CHANNEL_TYPES,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "name",
          description: "Policy name",
          required: true,
          max_length: 100,
        },
        {
          type: ApplicationCommandOptionType.Role,
          name: "role",
          description: "Members of this role become targets",
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "list",
      description: "List a channel's auto-track policies",
      options: [
        {
          type: ApplicationCommandOptionType.Channel,
          name: "channel",
          description: "Text or announcement channel (default: this one)",
          required: false,
          channel_types: POLICY_CHANNEL_TYPES,
        },
        {
          type: ApplicationCommandOptionType.Integer,
          name: "page",
          description: "Page number",
          required: false,
          min_value: 1,
        },
      ],
    },
  ],
};

/** integration_types / contexts apply only to global commands; strip them for guild registration. */
export function commandsFor(scope: "global"): RESTPutAPIApplicationCommandsJSONBody;
export function commandsFor(scope: "guild"): RESTPutAPIApplicationGuildCommandsJSONBody;
export function commandsFor(
  scope: "global" | "guild",
): RESTPutAPIApplicationCommandsJSONBody | RESTPutAPIApplicationGuildCommandsJSONBody {
  if (scope === "global") return [trackSeenCommand, autotrackCommand];
  const { integration_types: _i, contexts: _c, ...trackSeen } = trackSeenCommand;
  const { integration_types: _i2, contexts: _c2, ...autotrack } = autotrackCommand;
  return [trackSeen, autotrack];
}
