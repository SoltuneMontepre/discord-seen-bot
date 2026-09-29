import { GatewayDispatchEvents } from "@discordjs/core";
import { WebSocketShardEvents } from "@discordjs/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/db/database.ts";
import { migrateToLatest } from "../../src/db/migrator.ts";
import { PolicyRepository } from "../../src/db/policy-repository.ts";
import { Repository } from "../../src/db/repository.ts";
import { MSG } from "../../src/discord/render/text.ts";
import type { TargetSource } from "../../src/domain/target-sources.ts";
import { message } from "../helpers/auto.ts";
import { type BotHarness, makeBot } from "../helpers/bot.ts";
import { newTracking } from "../helpers/db.ts";
import { T0 } from "../helpers/domain.ts";
import { autotrackInteraction } from "../helpers/interactions.ts";
import { CHANNEL, GUILD } from "../helpers/scenario.ts";
import { tempDbPath } from "../helpers/tmp.ts";

const OFF = { mentionAutoTrack: false, roleTargets: false };
const M_ONLY = { mentionAutoTrack: true, roleTargets: false };
const R_ONLY = { mentionAutoTrack: false, roleTargets: true };
const BOTH = { mentionAutoTrack: true, roleTargets: true };

let h: BotHarness | undefined;
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.useRealTimers();
});

async function started(features: typeof OFF) {
  h = await makeBot({ features });
  h.discord.guildRoles.set(GUILD, [GUILD, "700", "701"]);
  await h.bot.start();
  h.gateway.emit(WebSocketShardEvents.Ready, {}, 0);
  return h;
}

/** Sends a MESSAGE_CREATE (stored in the fake history first) and waits for handlers to settle. */
async function send(payload: ReturnType<typeof message>) {
  if (!h) throw new Error();
  h.discord.addMessage(payload.channel_id, payload.id, payload.author.id);
  h.gateway.dispatch(GatewayDispatchEvents.MessageCreate, payload);
  await vi.advanceTimersByTimeAsync(0);
  await h.bot.m9.queue.run(GUILD, async () => {});
  await vi.advanceTimersByTimeAsync(0);
}

async function autoRows() {
  if (!h) throw new Error();
  return h.bot.repo.listActiveAuto({});
}

async function guildCreate() {
  if (!h) throw new Error();
  h.gateway.dispatch(GatewayDispatchEvents.GuildCreate, { id: GUILD });
  await vi.waitFor(() => expect(h?.bot.m9.autoHealth?.state(GUILD)).toBe("healthy"));
}

describe("flag matrix", () => {
  it("both off: exactly M0–M7 — no auto tracking, /autotrack disabled, intents 3585", async () => {
    await started(OFF);
    expect(h?.intents).toEqual([3585]);
    expect(h?.bot.m9.coordinator).toBeUndefined();
    await send(message({ users: ["1"] }));
    expect(await autoRows()).toEqual([]);
    await h?.bot.router.handle(autotrackInteraction("list", []));
    expect(h?.responder.text()).toBe(MSG.autotrackDisabled);
  });

  it("mention only: explicit users tracked, roles ignored, no member handlers, intents 3585", async () => {
    await started(M_ONLY);
    expect(h?.intents).toEqual([3585]);
    expect(h?.bot.m9.autoHealth).toBeUndefined();
    await send(message({ users: ["1"], roles: ["700"] }));
    const [t] = await autoRows();
    expect(await h?.bot.repo.listTrackingSources(t?.id ?? 0)).toEqual([
      { type: "user", userId: "1" },
    ]);
    h?.gateway.dispatch(GatewayDispatchEvents.GuildMemberUpdate, {
      guild_id: GUILD,
      user: { id: "2" },
      roles: ["700"],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await h?.bot.repo.listTargets(t?.id ?? 0)).toHaveLength(1);
  });

  it("roles only: policies apply, mentions are not collected, intents 3587", async () => {
    await started(R_ONLY);
    expect(h?.intents).toEqual([3587]);
    await h?.bot.m9.policies.create({
      guildId: GUILD,
      channelId: CHANNEL,
      name: "p",
      roleIds: ["700"],
      actor: "9",
      at: T0,
    });
    h?.discord.setMember(GUILD, "1", ["700"]);
    await guildCreate();
    await send(message({ users: ["2"] }));
    const [t] = await autoRows();
    expect((await h?.bot.repo.listTargets(t?.id ?? 0))?.map((x) => x.userId)).toEqual(["1"]);
    await send(message({ users: ["2"], channelId: "601" }));
    expect(await autoRows()).toHaveLength(1);
  });

  it("both on: mentions, mentioned roles and policies; member events reconcile", async () => {
    await started(BOTH);
    expect(h?.intents).toEqual([3587]);
    h?.discord.setMember(GUILD, "1", ["701"]);
    await guildCreate();
    await send(message({ users: ["2"], roles: ["701"], channelId: "601" }));
    const [t] = await autoRows();
    expect((await h?.bot.repo.listTargets(t?.id ?? 0))?.map((x) => x.userId).sort()).toEqual([
      "1",
      "2",
    ]);
    h?.gateway.dispatch(GatewayDispatchEvents.GuildMemberUpdate, {
      guild_id: GUILD,
      user: { id: "3" },
      roles: ["701"],
    });
    await vi.waitFor(async () =>
      expect((await h?.bot.repo.listTargets(t?.id ?? 0))?.map((x) => x.userId).sort()).toEqual([
        "1",
        "2",
        "3",
      ]),
    );
  });
});

describe("feature-disabled startup sweep (D6)", () => {
  let tmp: ReturnType<typeof tempDbPath>;
  const ids: Record<string, number> = {};

  async function seed() {
    tmp = tempDbPath("d6");
    const handle = openDatabase(tmp.path);
    await migrateToLatest(handle.db);
    const repo = new Repository(handle.db);
    await new PolicyRepository(handle.db).create({
      guildId: GUILD,
      channelId: CHANNEL,
      name: "inert",
      roleIds: ["700"],
      actor: "9",
      at: T0,
    });
    const auto = async (key: string, targets: string[], sources: TargetSource[]) => {
      const r = await repo.insertAutoTracking(newTracking({ channelType: 0 }), targets, sources);
      if (!r.ok) throw new Error();
      await repo.setStatusMessageId(r.tracked.id, `9${r.tracked.id}`);
      ids[key] = r.tracked.id;
    };
    await auto(
      "mixed",
      ["1", "2"],
      [
        { type: "user", userId: "1" },
        { type: "role", roleId: "700" },
      ],
    );
    await auto("policyDerived", ["3"], []);
    await auto("explicit", ["4"], [{ type: "user", userId: "4" }]);
    const m = await repo.insertTracking(newTracking(), ["5"]);
    if (!m.ok) throw new Error();
    await repo.setStatusMessageId(m.tracked.id, "95");
    ids.manual = m.tracked.id;
    await handle.close();
  }

  afterEach(() => tmp?.cleanup());

  it("stops mixed and role-derived auto trackings with feature_disabled (rows kept), before the gateway", async () => {
    await seed();
    h = await makeBot({ features: M_ONLY, dbPath: tmp.path });
    const original = h.bot.repo.stopAuto.bind(h.bot.repo);
    const order = h.order;
    h.bot.repo.stopAuto = async (...a) => {
      order.push("stopAuto");
      return original(...a);
    };
    await h.bot.start();
    expect(order.indexOf("stopAuto")).toBeLessThan(order.indexOf("gateway created"));
    const get = (k: string) => h?.bot.repo.getTracked(ids[k] ?? 0);
    expect((await get("mixed"))?.stopReason).toBe("feature_disabled");
    expect((await get("policyDerived"))?.stopReason).toBe("feature_disabled");
    expect((await get("explicit"))?.stoppedAt).toBeNull(); // inert policy in its channel does not matter
    expect((await get("manual"))?.stoppedAt).toBeNull();
    expect(await h.bot.repo.listTargets(ids.mixed ?? 0)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.discord.count("editCompanion")).toBe(2); // frozen cards refreshed via the scheduler
  });

  it("a second start is a no-op; with role targets on nothing is swept", async () => {
    await seed();
    h = await makeBot({ features: OFF, dbPath: tmp.path });
    await h.bot.start();
    await h.close();
    h = await makeBot({ features: OFF, dbPath: tmp.path });
    await h.bot.start();
    expect(
      h.logger.entries.some((e) => e.msg?.startsWith("stopped role-dependent auto trackings")),
    ).toBe(false);
    await h.close();

    await seed();
    h = await makeBot({ features: BOTH, dbPath: tmp.path });
    await h.bot.start();
    expect((await h.bot.repo.getTracked(ids.mixed ?? 0))?.stoppedAt).toBeNull();
  });
});
