/**
 * Registers "Apps → Track Seen". Bulk overwrite is idempotent — safe to re-run.
 *   pnpm register-commands -- --guild <GUILD_ID>   (dev: instant)
 *   pnpm register-commands -- --global             (prod)
 */
import { commandsFor } from "../src/discord/commands.ts";
import { arg, setup } from "./_common.ts";

const { config, api } = setup();
const guildId = arg("guild");
const global = process.argv.includes("--global");

if (!guildId && !global) {
  console.error("Usage: pnpm register-commands -- --guild <GUILD_ID> | --global");
  process.exit(2);
}

const result = guildId
  ? await api.applicationCommands.bulkOverwriteGuildCommands(
      config.applicationId,
      guildId,
      commandsFor("guild"),
    )
  : await api.applicationCommands.bulkOverwriteGlobalCommands(
      config.applicationId,
      commandsFor("global"),
    );

console.log(
  `Registered ${result.length} command(s) ${guildId ? `in guild ${guildId}` : "globally"}:`,
  result.map((c) => `${c.name} (type ${c.type}, id ${c.id})`).join(", "),
);
