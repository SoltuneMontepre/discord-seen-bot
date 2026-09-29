import { EventEmitter } from "node:events";
import { WebSocketShardEvents } from "@discordjs/ws";
import { type Bot, createBot } from "../../src/bot.ts";
import { openDatabase } from "../../src/db/database.ts";
import type { GatewayLike } from "../../src/discord/gateway.ts";
import { DEFAULT_POLICY, type Policy } from "../../src/domain/policy.ts";
import { dateClock, memoryLogger } from "./app.ts";
import { FakeDiscord } from "./fake-discord.ts";
import { APP_ID, FakeResponder } from "./interactions.ts";
import { tempDbPath } from "./tmp.ts";

export class FakeGateway extends EventEmitter {
  connected = false;
  destroyed = false;
  async connect() {
    this.connected = true;
  }
  async destroy() {
    this.destroyed = true;
  }
  dispatch(t: string, d: unknown) {
    this.emit(WebSocketShardEvents.Dispatch, { t, d }, 0);
  }
}

export interface BotHarness {
  bot: Bot;
  gateway: FakeGateway;
  discord: FakeDiscord;
  responder: FakeResponder;
  logger: ReturnType<typeof memoryLogger>;
  order: string[];
  intents: number[];
  fatal: string[];
  dbPath: string;
  close(): Promise<void>;
}

/** createBot on a temp-file DB with fakes; `order` records "gateway created". */
export async function makeBot(
  o: {
    features?: { mentionAutoTrack: boolean; roleTargets: boolean };
    dbPath?: string;
    discord?: FakeDiscord;
    policy?: Partial<Policy>;
    debugPayloads?: boolean;
  } = {},
): Promise<BotHarness> {
  const tmp = o.dbPath ? undefined : tempDbPath("bot-m9");
  const dbPath = o.dbPath ?? tmp?.path ?? "";
  const handle = openDatabase(dbPath);
  const discord = o.discord ?? new FakeDiscord();
  const responder = new FakeResponder();
  const gateway = new FakeGateway();
  const logger = memoryLogger();
  const order: string[] = [];
  const intents: number[] = [];
  const fatal: string[] = [];
  const bot = createBot({
    db: handle.db,
    port: discord,
    responder,
    createGateway: (i) => {
      order.push("gateway created");
      intents.push(i);
      return gateway as unknown as GatewayLike;
    },
    applicationId: APP_ID,
    policy: { ...DEFAULT_POLICY, ...o.policy },
    logger,
    clock: dateClock,
    ...(o.features ? { features: o.features } : {}),
    onFatal: (reason) => fatal.push(reason),
    ...(o.debugPayloads ? { debugPayloads: true } : {}),
  });
  return {
    bot,
    gateway,
    discord,
    responder,
    logger,
    order,
    intents,
    fatal,
    dbPath,
    async close() {
      await bot.stop();
      await handle.close();
      tmp?.cleanup();
    },
  };
}
