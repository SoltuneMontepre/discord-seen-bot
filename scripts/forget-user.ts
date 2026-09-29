/**
 * Deletion request tool (Developer Terms §5b):
 *   pnpm forget-user -- <USER_ID>
 * Deletes the user's targets, evidence and acknowledgements everywhere, anonymizes references to
 * "0", and re-renders affected active cards. Stop the bot first or run it alongside (single writer
 * with busy_timeout).
 */
import { systemClock } from "../src/app/ports.ts";
import { RenderScheduler } from "../src/app/render-scheduler.ts";
import { openDatabase } from "../src/db/database.ts";
import { Repository } from "../src/db/repository.ts";
import { CoreDiscordPort } from "../src/discord/discord-port.ts";
import { cardRenderer } from "../src/discord/render/card.ts";
import { createLogger } from "../src/logger.ts";
import { setup } from "./_common.ts";

const userId = process.argv.slice(2).find((a) => /^\d{17,20}$/.test(a));
if (!userId) {
  console.error("Usage: pnpm forget-user -- <USER_ID>");
  process.exit(2);
}

const { config, api } = setup();
const { db, close } = openDatabase(config.databasePath);
const repo = new Repository(db);
const affected = await repo.forgetUser(userId);
console.log(`Removed data for user ${userId}; ${affected.length} tracked message(s) affected.`);

const scheduler = new RenderScheduler({
  repo,
  renderer: cardRenderer,
  port: new CoreDiscordPort(api),
  clock: systemClock,
  policy: config.policy,
  logger: createLogger("warn"),
});
for (const id of affected) {
  const t = await repo.getTracked(id);
  if (t && t.stoppedAt === null) await scheduler.renderNow(id);
}
await close();
