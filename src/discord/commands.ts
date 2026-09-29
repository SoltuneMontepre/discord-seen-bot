import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  type RESTPostAPIContextMenuApplicationCommandsJSONBody,
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

/** integration_types / contexts apply only to global commands; strip them for guild registration. */
export function commandsFor(
  scope: "global" | "guild",
): RESTPostAPIContextMenuApplicationCommandsJSONBody[] {
  if (scope === "global") return [trackSeenCommand];
  const { integration_types: _i, contexts: _c, ...guildCommand } = trackSeenCommand;
  return [guildCommand];
}
