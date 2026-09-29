import { GatewayDispatchEvents } from "@discordjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BotHarness, makeBot } from "../helpers/bot.ts";
import { T0 } from "../helpers/domain.ts";
import { CHANNEL, GUILD } from "../helpers/scenario.ts";

let h: BotHarness;
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await h.close();
  vi.useRealTimers();
});

async function seedPolicies() {
  const p = h.bot.m9.policies;
  const mk = (guildId: string, channelId: string) =>
    p.create({ guildId, channelId, name: "p", roleIds: ["700"], actor: "9", at: T0 });
  return {
    here: await mk(GUILD, CHANNEL),
    sibling: await mk(GUILD, "601"),
    other: await mk("501", "602"),
  };
}

async function sourceCount() {
  return (
    (await h.bot.m9.policies.allRoleIds(GUILD)).length +
    (await h.bot.m9.policies.allRoleIds("501")).length
  );
}

describe("lifecycle cleanup", () => {
  it("CHANNEL_DELETE removes that channel's policies only; trackings stop channel_deleted as before", async () => {
    h = await makeBot({ features: { mentionAutoTrack: true, roleTargets: true } });
    await h.bot.start();
    const { here, sibling, other } = await seedPolicies();
    const r = await h.bot.repo.insertTracking(
      {
        guildId: GUILD,
        channelId: CHANNEL,
        parentChannelId: null,
        sourceMessageId: "77",
        sourceAuthorId: "100",
        sourceCreatedAt: T0,
        creatorUserId: "100",
        createdAt: T0,
        weakWindowEndsAt: T0 + 1,
        expiresAt: T0 + 2,
      },
      ["1"],
    );
    if (!r.ok) throw new Error();
    await h.bot.repo.setStatusMessageId(r.tracked.id, "88");
    h.gateway.dispatch(GatewayDispatchEvents.ChannelDelete, {
      id: CHANNEL,
      guild_id: GUILD,
      type: 0,
    });
    await vi.waitFor(async () => expect(await h.bot.m9.policies.get(here.id)).toBeUndefined());
    expect(await h.bot.m9.policies.get(sibling.id)).toBeDefined();
    expect(await h.bot.m9.policies.get(other.id)).toBeDefined();
    expect((await h.bot.repo.getTracked(r.tracked.id))?.stopReason).toBe("channel_deleted");
  });

  it("CHANNEL_DELETE with both M9 flags off still deletes leftover policies", async () => {
    h = await makeBot();
    await h.bot.start();
    const { here } = await seedPolicies();
    h.gateway.dispatch(GatewayDispatchEvents.ChannelDelete, {
      id: CHANNEL,
      guild_id: GUILD,
      type: 0,
    });
    await vi.waitFor(async () => expect(await h.bot.m9.policies.get(here.id)).toBeUndefined());
  });

  it("THREAD_DELETE affects no policy rows", async () => {
    h = await makeBot({ features: { mentionAutoTrack: false, roleTargets: true } });
    await h.bot.start();
    await seedPolicies();
    const before = await sourceCount();
    h.gateway.dispatch(GatewayDispatchEvents.ThreadDelete, {
      id: "650",
      guild_id: GUILD,
      parent_id: CHANNEL,
      type: 11,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await sourceCount()).toBe(before);
  });

  it("GUILD_REMOVED purges that guild's policies and trackings; index and health cleared", async () => {
    h = await makeBot({ features: { mentionAutoTrack: false, roleTargets: true } });
    h.discord.guildRoles.set(GUILD, [GUILD, "700"]);
    h.discord.setMember(GUILD, "1", ["700"]);
    await h.bot.start();
    const { here, other } = await seedPolicies();
    h.gateway.dispatch(GatewayDispatchEvents.GuildCreate, { id: GUILD });
    await vi.waitFor(() => expect(h.bot.m9.autoHealth?.state(GUILD)).toBe("healthy"));
    expect(h.bot.m9.index?.memberCount(GUILD)).toBe(1);
    h.gateway.dispatch(GatewayDispatchEvents.GuildDelete, { id: GUILD });
    await vi.waitFor(async () => expect(await h.bot.m9.policies.get(here.id)).toBeUndefined());
    expect(await h.bot.m9.policies.get(other.id)).toBeDefined();
    await vi.waitFor(() => expect(h.bot.m9.index?.memberCount(GUILD)).toBe(0));
    expect(h.bot.m9.autoHealth?.state(GUILD)).toBe("awaiting_guild");
  });
});
