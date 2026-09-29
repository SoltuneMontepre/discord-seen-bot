import { API } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { systemClock } from "./app/ports.ts";
import { createBot } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { CoreDiscordPort } from "./discord/discord-port.ts";

import { CoreResponder } from "./discord/interactions/responder.ts";
import { createLogger } from "./logger.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, !config.production && process.stdout.isTTY === true);

  const database = openDatabase(config.databasePath);
  const rest = new REST({ version: "10" }).setToken(config.token);
  const api = new API(rest);

  const bot = createBot({
    db: database.db,
    port: new CoreDiscordPort(api),
    responder: new CoreResponder(api, config.applicationId),
    // createBot derives the intents from the flags and checks them (assertAllowedIntents).
    createGateway: (intents) => new WebSocketManager({ token: config.token, intents, rest }),
    applicationId: config.applicationId,
    policy: config.policy,
    logger,
    clock: systemClock,
    debugPayloads: config.debugPayloads,
    features: config.features,
    onFatal: (reason) => void shutdown("fatal", reason),
  });

  let stopping = false;
  async function shutdown(signal: string, fatalReason?: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    if (fatalReason) logger.error({ reason: fatalReason }, "fatal: shutting down");
    else logger.info({ signal }, "shutting down");
    try {
      await bot.stop();
    } finally {
      await database.close();
      process.exit(fatalReason ? 1 : 0);
    }
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await bot.start();
}

main().catch((err: unknown) => {
  const configError = err instanceof Error && err.message.startsWith("Invalid configuration");
  console.error("fatal:", configError ? err.message : err);
  process.exit(1);
});
