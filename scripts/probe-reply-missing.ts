/**
 * Manual checklist item 22 (dev only): confirms the error shape Discord returns when replying to a
 * message that no longer exists with fail_if_not_exists: true, and that it maps to SourceMissing.
 *   pnpm probe:reply-missing -- --channel <TEST_CHANNEL_ID>
 */
import { DiscordAPIError } from "@discordjs/rest";
import { mapCreateCompanionError } from "../src/discord/discord-port.ts";
import { arg, devOnly, setup } from "./_common.ts";

const { config, api } = setup();
devOnly(config.production, "probe:reply-missing");
const channelId = arg("channel");
if (!channelId) {
  console.error("Usage: pnpm probe:reply-missing -- --channel <TEST_CHANNEL_ID>");
  process.exit(2);
}

const probe = await api.channels.createMessage(channelId, {
  content: "seen-bot probe (will be deleted)",
});
await api.channels.deleteMessage(channelId, probe.id);
try {
  const unexpected = await api.channels.createMessage(channelId, {
    content: "seen-bot probe reply (should not exist)",
    message_reference: { message_id: probe.id, fail_if_not_exists: true },
  });
  console.error("UNEXPECTED: Discord accepted a reply to a deleted message. Cleaning up.");
  await api.channels.deleteMessage(channelId, unexpected.id);
  process.exit(1);
} catch (err) {
  if (err instanceof DiscordAPIError) {
    console.log("HTTP status:", err.status);
    console.log("JSON code:", err.code);
    console.log("raw error:", JSON.stringify(err.rawError, null, 2));
  } else {
    console.log("non-API error:", err);
  }
  const mapped = mapCreateCompanionError(err);
  console.log("mapCreateCompanionError →", mapped);
  if (mapped.kind !== "SourceMissing") {
    console.error("MISMATCH: update mapCreateCompanionError and add this shape as a test fixture.");
    process.exit(1);
  }
  console.log("OK: classified as SourceMissing.");
}
