/**
 * Manual checklist item 22b (dev only): verifies on real Discord that backward `before` pagination
 * returns the messages immediately preceding the cursor, so walkHistoryRange sees every message.
 *   pnpm probe:history -- --channel <TEST_CHANNEL_ID> [--count 150]
 */
import { walkHistoryRange } from "../src/app/history-range.ts";
import { CoreDiscordPort } from "../src/discord/discord-port.ts";
import { snowflakeFromTime } from "../src/domain/snowflake.ts";
import { arg, devOnly, setup } from "./_common.ts";

const { config, api } = setup();
devOnly(config.production, "probe:history");
const channelId = arg("channel");
const count = Number(arg("count") ?? 150);
if (!channelId) {
  console.error("Usage: pnpm probe:history -- --channel <TEST_CHANNEL_ID> [--count 150]");
  process.exit(2);
}

const posted: string[] = [];
console.log(`Posting ${count} probe messages (rate limits handled by @discordjs/rest)…`);
for (let i = 0; i < count; i++) {
  const m = await api.channels.createMessage(channelId, {
    content: `seen-bot history probe ${i + 1}/${count}`,
  });
  posted.push(m.id);
}

const port = new CoreDiscordPort(api);
const probeSet = new Set(posted);
const delivered: string[] = [];
const pageOrders: string[] = [];
const originalGet = port.getMessagesBefore.bind(port);
port.getMessagesBefore = async (ch, before, limit) => {
  const r = await originalGet(ch, before, limit);
  if (r.ok && r.value.length > 1) {
    const ids = r.value.map((m) => BigInt(m.id));
    const desc = ids.every((id, i) => i === 0 || (ids[i - 1] as bigint) > id);
    pageOrders.push(desc ? "newest→oldest" : "other");
  }
  return r;
};

const result = await walkHistoryRange({
  port,
  channelId,
  lowerExclusive: BigInt(posted[0] as string) - 1n,
  upperExclusive: snowflakeFromTime(Date.now() + 60_000),
  onMessages: async (msgs) => {
    for (const m of msgs) if (probeSet.has(m.id)) delivered.push(m.id);
  },
});

const unique = new Set(delivered);
console.log(
  `pages: ${result.pages}, outcome: ${result.outcome}, page orders: ${[...new Set(pageOrders)].join(", ")}`,
);
console.log(
  `delivered ${unique.size}/${count} probe ids (${delivered.length - unique.size} duplicates)`,
);

console.log("Deleting probe messages…");
for (const id of posted) await api.channels.deleteMessage(channelId, id);

if (unique.size !== count || delivered.length !== count) {
  console.error("FAIL: backward pagination did not deliver every probe message exactly once.");
  process.exit(1);
}
console.log("OK: every probe message delivered exactly once.");
