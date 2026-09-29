import { EventEmitter } from "node:events";
import { GatewayDispatchEvents } from "@discordjs/core";
import { WebSocketShardEvents } from "@discordjs/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Bot, createBot } from "../../src/bot.ts";
import { openDatabase } from "../../src/db/database.ts";
import { migrateToLatest } from "../../src/db/migrator.ts";
import { Repository } from "../../src/db/repository.ts";
import { dispatchToSignal, type GatewayLike } from "../../src/discord/gateway.ts";
import {
  assertNoPrivilegedIntents,
  INTENTS,
  PRIVILEGED_INTENTS,
} from "../../src/discord/intents.ts";
import { DEFAULT_POLICY } from "../../src/domain/policy.ts";
import { dateClock, memoryLogger } from "../helpers/app.ts";
import { newTracking } from "../helpers/db.ts";
import { MIN, T0 } from "../helpers/domain.ts";
import { FakeDiscord } from "../helpers/fake-discord.ts";
import { APP_ID, FakeResponder, trackSeenInteraction } from "../helpers/interactions.ts";
import { AUTHOR, CHANNEL, nextId } from "../helpers/scenario.ts";
import { tempDbPath } from "../helpers/tmp.ts";

class FakeGateway extends EventEmitter {
  connected = false;
  destroyed = false;
  async connect() {
    this.connected = true;
  }
  async destroy() {
    this.destroyed = true;
  }
}

let tmp: ReturnType<typeof tempDbPath>;
let handle: ReturnType<typeof openDatabase>;
let discord: FakeDiscord;
let responder: FakeResponder;
let gateway: FakeGateway;
let bot: Bot;
let logger: ReturnType<typeof memoryLogger>;
const order: string[] = [];

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
  tmp = tempDbPath("bot");
  handle = openDatabase(tmp.path);
  discord = new FakeDiscord();
  responder = new FakeResponder();
  gateway = new FakeGateway();
  logger = memoryLogger();
  order.length = 0;
  bot = createBot({
    db: handle.db,
    port: discord,
    responder,
    createGateway: () => {
      order.push("gateway created");
      return gateway as unknown as GatewayLike;
    },
    applicationId: APP_ID,
    policy: DEFAULT_POLICY,
    logger,
    clock: dateClock,
  });
});

afterEach(async () => {
  await bot.stop();
  await handle.close();
  tmp.cleanup();
  vi.useRealTimers();
});

describe("intents", () => {
  it("are exactly 3585 with no privileged bits", () => {
    expect(INTENTS).toBe(3585);
    expect(INTENTS & PRIVILEGED_INTENTS).toBe(0);
    expect(() => assertNoPrivilegedIntents(INTENTS | (1 << 15))).toThrow(/Privileged/);
  });
});

describe("bot lifecycle", () => {
  it("deletes unfinished starts before the gateway exists (no interaction can arrive earlier)", async () => {
    await migrateToLatest(handle.db);
    const repo = new Repository(handle.db);
    await repo.insertTracking(newTracking({ sourceMessageId: "4242" }), ["1"]);
    const original = Repository.prototype.deleteUnfinishedStarts;
    const spy = vi
      .spyOn(Repository.prototype, "deleteUnfinishedStarts")
      .mockImplementation(async function (this: Repository) {
        order.push("unfinished starts deleted");
        return original.call(this);
      });
    await bot.start();
    expect(order).toEqual(["unfinished starts deleted", "gateway created"]);
    expect(gateway.connected).toBe(true);
    expect(await repo.findActiveBySource("4242")).toBeUndefined();
    spy.mockRestore();
  });

  it("really removes an unfinished start on boot", async () => {
    await migrateToLatest(handle.db);
    const repo = new Repository(handle.db);
    await repo.insertTracking(newTracking({ sourceMessageId: "4243" }), ["1"]);
    await bot.start();
    expect(await repo.findActiveBySource("4243")).toBeUndefined();
  });

  it("READY runs the fresh-session reconciliation; RESUMED does not", async () => {
    await bot.start();
    const fresh = vi.spyOn(bot.reconciler, "onFreshSession");
    gateway.emit(WebSocketShardEvents.Closed, 1006, 0);
    gateway.emit(WebSocketShardEvents.Resumed, 0);
    expect(fresh).not.toHaveBeenCalled();
    expect(bot.health.connection).toBe("up");
    expect(discord.calls).toEqual([]);

    gateway.emit(WebSocketShardEvents.Ready, {}, 0);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(bot.health.gapRecoveryPending).toBe(true);
  });

  it("the watermark ticker advances only while healthy", async () => {
    await bot.start();
    gateway.emit(WebSocketShardEvents.Ready, {}, 0);
    await vi.waitFor(() => expect(bot.health.gapRecoveryPending).toBe(false));
    for (let i = 1; i <= 2; i++) {
      gateway.emit(
        WebSocketShardEvents.HeartbeatComplete,
        { ackAt: Date.now(), heartbeatAt: 0, latency: 1 },
        0,
      );
      await vi.advanceTimersByTimeAsync(MIN);
    }
    const w1 = await bot.repo.getWatermark();
    expect(w1).toBe(T0 + 2 * MIN);
    gateway.emit(WebSocketShardEvents.Closed, 1006, 0);
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(await bot.repo.getWatermark()).toBe(w1);
  });

  it("routes dispatches: interactions to the router, events through adapters", async () => {
    await bot.start();
    const src = nextId(T0 - MIN);
    discord.addMessage(CHANNEL, src, AUTHOR);
    gateway.emit(
      WebSocketShardEvents.Dispatch,
      {
        t: GatewayDispatchEvents.InteractionCreate,
        d: trackSeenInteraction({ id: src, authorId: AUTHOR, mentions: [{ id: "1" }] }),
      },
      0,
    );
    await vi.waitFor(async () => expect(await bot.repo.listActive()).toHaveLength(1));
    const [t] = await bot.repo.listActive();

    const replyId = nextId(T0 + MIN);
    gateway.emit(
      WebSocketShardEvents.Dispatch,
      {
        t: GatewayDispatchEvents.MessageCreate,
        d: {
          id: replyId,
          channel_id: CHANNEL,
          guild_id: "500",
          type: 19,
          author: { id: "1" },
          message_reference: { message_id: src },
        },
      },
      0,
    );
    await vi.waitFor(async () =>
      expect((await bot.repo.listEvidence(t?.id ?? 0)).some((e) => e.kind === "DIRECT_REPLY")).toBe(
        true,
      ),
    );
  });

  it("shutdown stops accepting interactions and destroys the gateway", async () => {
    await bot.start();
    await bot.stop();
    expect(gateway.destroyed).toBe(true);
    expect(bot.router.accepting).toBe(false);
  });
});

describe("dispatchToSignal", () => {
  it("ignores irrelevant dispatches (e.g. presence) and handles guild outage vs removal", () => {
    expect(
      dispatchToSignal({ t: GatewayDispatchEvents.PresenceUpdate, d: {} } as never),
    ).toBeNull();
    expect(
      dispatchToSignal({
        t: GatewayDispatchEvents.GuildDelete,
        d: { id: "g", unavailable: true },
      } as never),
    ).toBeNull();
    expect(
      dispatchToSignal({ t: GatewayDispatchEvents.GuildDelete, d: { id: "g" } } as never),
    ).toEqual({ t: "GUILD_REMOVED", guildId: "g" });
  });
});
