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

describe("M9 gateway wiring", () => {
  let m9: import("../helpers/bot.ts").BotHarness;
  afterEach(async () => m9?.close());

  const make = async (features: { mentionAutoTrack: boolean; roleTargets: boolean }) => {
    const { makeBot } = await import("../helpers/bot.ts");
    m9 = await makeBot({ features });
    await m9.bot.start();
    return m9;
  };

  it("RESUMED triggers no rebuild and no health change", async () => {
    await make({ mentionAutoTrack: false, roleTargets: true });
    m9.bot.m9.autoHealth?.set("500", "healthy");
    m9.gateway.emit(WebSocketShardEvents.Resumed, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(m9.bot.m9.autoHealth?.state("500")).toBe("healthy");
    expect(m9.discord.count("getGuildRoleIds")).toBe(0);
  });

  it("READY → every guild awaiting_guild; GUILD_CREATE → rebuild", async () => {
    await make({ mentionAutoTrack: false, roleTargets: true });
    await m9.bot.m9.policies.create({
      guildId: "500",
      channelId: "600",
      name: "p",
      roleIds: ["700"],
      actor: "9",
      at: T0,
    });
    m9.discord.guildRoles.set("500", ["500", "700"]);
    m9.bot.m9.autoHealth?.set("500", "healthy");
    m9.gateway.emit(WebSocketShardEvents.Ready, {}, 0);
    expect(m9.bot.m9.autoHealth?.state("500")).toBe("awaiting_guild");
    m9.gateway.dispatch(GatewayDispatchEvents.GuildCreate, { id: "500" });
    await vi.waitFor(() => expect(m9.bot.m9.autoHealth?.state("500")).toBe("healthy"));
    expect(m9.discord.count("listGuildMembers")).toBe(1);
  });

  it("close code 4014 invokes onFatal with the explicit message", async () => {
    await make({ mentionAutoTrack: false, roleTargets: true });
    m9.gateway.emit(WebSocketShardEvents.Closed, 4014, 0);
    expect(m9.fatal).toEqual([
      "Disallowed intents: enable Server Members Intent in the Developer Portal or set ROLE_TARGETS_ENABLED=false",
    ]);
  });

  it("member events are not handled when the role flag is off", async () => {
    await make({ mentionAutoTrack: true, roleTargets: false });
    m9.gateway.dispatch(GatewayDispatchEvents.GuildCreate, { id: "500" });
    m9.gateway.dispatch(GatewayDispatchEvents.GuildMemberUpdate, {
      guild_id: "500",
      user: { id: "1" },
      roles: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(m9.bot.m9.autoHealth).toBeUndefined();
    expect(m9.discord.count("getGuildRoleIds")).toBe(0);
  });

  it("a sweeper tick schedules a referenced-role prune per indexed guild", async () => {
    await make({ mentionAutoTrack: false, roleTargets: true });
    m9.bot.m9.index?.setReferencedRoles("500", ["700"]);
    m9.bot.m9.index?.setReferencedRoles("501", ["800"]);
    const spy = vi.spyOn(
      m9.bot.m9.coordinator as NonNullable<typeof m9.bot.m9.coordinator>,
      "requestReferencedRolePrune",
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.sweepIntervalMs);
    await vi.waitFor(() => expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(["500", "501"]));
  });

  it("a missing channel_type is logged at debug and creates nothing", async () => {
    await make({ mentionAutoTrack: true, roleTargets: false });
    m9.gateway.dispatch(GatewayDispatchEvents.MessageCreate, {
      id: nextId(T0),
      channel_id: CHANNEL,
      guild_id: "500",
      type: 0,
      author: { id: AUTHOR },
      mentions: [{ id: "1" }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await m9.bot.repo.listActiveAuto({})).toEqual([]);
    expect(
      m9.logger.entries.some(
        (e) => e.level === "debug" && e.msg === "auto-track skipped: channel_type missing",
      ),
    ).toBe(true);
  });
});
