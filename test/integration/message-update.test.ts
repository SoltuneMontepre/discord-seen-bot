import { GatewayDispatchEvents } from "@discordjs/core";
import { WebSocketShardEvents } from "@discordjs/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { message } from "../helpers/auto.ts";
import { type BotHarness, makeBot } from "../helpers/bot.ts";
import { MIN, T0 } from "../helpers/domain.ts";
import { CHANNEL, GUILD } from "../helpers/scenario.ts";

let h: BotHarness;
beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
  h = await makeBot({ features: { mentionAutoTrack: true, roleTargets: true } });
  h.discord.guildRoles.set(GUILD, [GUILD, "700"]);
  await h.bot.start();
  h.gateway.emit(WebSocketShardEvents.Ready, {}, 0);
});
afterEach(async () => {
  await h.close();
  vi.useRealTimers();
});

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await h.bot.m9.queue.run(GUILD, async () => {});
  await vi.advanceTimersByTimeAsync(0);
}

async function create(payload: ReturnType<typeof message>) {
  h.discord.addMessage(payload.channel_id, payload.id, payload.author.id);
  h.gateway.dispatch(GatewayDispatchEvents.MessageCreate, payload);
  await settle();
}

const targets = async (id: number) =>
  (await h.bot.repo.listTargets(id)).map((t) => t.userId).sort();

describe("message edits (E1: sources frozen at MESSAGE_CREATE)", () => {
  it("#40a: edit @An → @Binh changes nothing; An's ack is kept", async () => {
    const m = message({ users: ["21"], channelId: "601" });
    await create(m);
    const [t] = await h.bot.repo.listActiveAuto({});
    if (!t) throw new Error();
    await h.bot.repo.acknowledge(t.id, "21", T0 + MIN);
    h.gateway.dispatch(GatewayDispatchEvents.MessageUpdate, {
      ...m,
      edited_timestamp: new Date(T0 + 2 * MIN).toISOString(),
      mentions: [{ id: "22" }],
    });
    await settle();
    expect(await h.bot.repo.listTrackingSources(t.id)).toEqual([{ type: "user", userId: "21" }]);
    expect(await targets(t.id)).toEqual(["21"]);
    expect((await h.bot.repo.getAck(t.id, "21"))?.revokedAt).toBeNull();
  });

  it("#40b: editing an untracked message to add a mention creates nothing", async () => {
    const m = message({ users: [], channelId: "601" });
    await create(m);
    expect(await h.bot.repo.listActiveAuto({})).toEqual([]);
    h.gateway.dispatch(GatewayDispatchEvents.MessageUpdate, { ...m, mentions: [{ id: "22" }] });
    await settle();
    expect(await h.bot.repo.listActiveAuto({})).toEqual([]);
  });

  it("#40c: role and policy changes still reconcile after an edit", async () => {
    await h.bot.m9.policies.create({
      guildId: GUILD,
      channelId: CHANNEL,
      name: "p",
      roleIds: ["700"],
      actor: "9",
      at: T0,
    });
    h.discord.setMember(GUILD, "1", ["700"]);
    h.gateway.dispatch(GatewayDispatchEvents.GuildCreate, { id: GUILD });
    await vi.waitFor(() => expect(h.bot.m9.autoHealth?.state(GUILD)).toBe("healthy"));
    const m = message({ users: ["21"] });
    await create(m);
    const [t] = await h.bot.repo.listActiveAuto({});
    if (!t) throw new Error();
    h.gateway.dispatch(GatewayDispatchEvents.MessageUpdate, { ...m, mentions: [] });
    await settle();
    h.gateway.dispatch(GatewayDispatchEvents.GuildMemberUpdate, {
      guild_id: GUILD,
      user: { id: "2" },
      roles: ["700"],
    });
    await vi.waitFor(async () => expect(await targets(t.id)).toEqual(["1", "2", "21"]));
  });
});
