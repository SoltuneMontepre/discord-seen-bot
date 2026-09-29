import type { API } from "@discordjs/core";
import { DiscordAPIError, HTTPError } from "@discordjs/rest";
import { describe, expect, it, vi } from "vitest";
import { commandsFor, trackSeenCommand } from "../../src/discord/commands.ts";
import { CoreDiscordPort } from "../../src/discord/discord-port.ts";

function apiError(code: number, status = 404) {
  return new DiscordAPIError({ code, message: "x" }, code, status, "GET", "/x", { body: {} });
}

function fakeApi() {
  const channels = {
    createMessage: vi.fn(async () => ({ id: "900" })),
    editMessage: vi.fn(async () => ({})),
    deleteMessage: vi.fn(async () => {}),
    getMessage: vi.fn(async () => ({ id: "1", author: { id: "2" }, reactions: [] })),
    getMessages: vi.fn(async () => [{ id: "5", channel_id: "c", type: 0, author: { id: "3" } }]),
    getMessageReactions: vi.fn(async () => [
      { id: "7", bot: false },
      { id: "8", bot: true },
    ]),
  };
  const guilds = {
    getMembers: vi.fn(async () => [
      { user: { id: "11" }, roles: ["700", "701"] },
      { user: { id: "12", bot: true }, roles: [] },
      { roles: ["700"] }, // no user object: skipped
    ]),
    getRoles: vi.fn(async () => [{ id: "500" }, { id: "700" }]),
  };
  return { api: { channels, guilds } as unknown as API, channels, guilds };
}

const body = { flags: 1 << 15, components: [], allowed_mentions: { parse: [] as never[] } };

describe("CoreDiscordPort request shapes", () => {
  it("createCompanion: reply with fail_if_not_exists=true, nonce + enforce_nonce, no pings", async () => {
    const { api, channels } = fakeApi();
    const r = await new CoreDiscordPort(api).createCompanion({
      channelId: "c",
      sourceMessageId: "s",
      nonce: "sb1t4",
      body,
    });
    expect(r).toEqual({ ok: true, messageId: "900" });
    expect(channels.createMessage).toHaveBeenCalledWith("c", {
      flags: 1 << 15,
      components: [],
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: { message_id: "s", fail_if_not_exists: true },
      nonce: "sb1t4",
      enforce_nonce: true,
    });
  });

  it("createCompanion maps a missing source to SourceMissing", async () => {
    const { api, channels } = fakeApi();
    channels.createMessage.mockRejectedValueOnce(apiError(10008));
    expect(
      await new CoreDiscordPort(api).createCompanion({
        channelId: "c",
        sourceMessageId: "s",
        nonce: "n",
        body,
      }),
    ).toEqual({
      ok: false,
      error: { kind: "SourceMissing" },
    });
  });

  it("getMessagesBefore sends a `before` cursor (never `after`) and adapts messages", async () => {
    const { api, channels } = fakeApi();
    const r = await new CoreDiscordPort(api).getMessagesBefore("c", 123n, 100);
    expect(channels.getMessages).toHaveBeenCalledWith("c", { before: "123", limit: 100 });
    expect(r).toEqual({
      ok: true,
      value: [{ id: "5", signals: [expect.objectContaining({ t: "MESSAGE", authorId: "3" })] }],
    });
  });

  it("lookups classify errors instead of throwing", async () => {
    const { api, channels } = fakeApi();
    channels.getMessage.mockRejectedValueOnce(apiError(10008));
    expect(await new CoreDiscordPort(api).getMessage("c", "m")).toMatchObject({
      ok: false,
      class: "NotFound",
      code: 10008,
    });
  });

  it("getReactionUsers passes type/limit/after and reports bot flags", async () => {
    const { api, channels } = fakeApi();
    const r = await new CoreDiscordPort(api).getReactionUsers("c", "m", "party:123", 1, "6", 100);
    expect(channels.getMessageReactions).toHaveBeenCalledWith("c", "m", "party:123", {
      type: 1,
      limit: 100,
      after: "6",
    });
    expect(r).toEqual({
      ok: true,
      value: [
        { id: "7", bot: false },
        { id: "8", bot: true },
      ],
    });
  });

  it("editCompanion suppresses pings and maps errors", async () => {
    const { api, channels } = fakeApi();
    const port = new CoreDiscordPort(api);
    expect(await port.editCompanion("c", "m", body)).toEqual({ ok: true });
    expect(channels.editMessage).toHaveBeenCalledWith("c", "m", {
      flags: 1 << 15,
      components: [],
      allowed_mentions: { parse: [] },
    });
    channels.editMessage.mockRejectedValueOnce(apiError(50083, 400));
    expect(await port.editCompanion("c", "m", body)).toEqual({
      ok: false,
      kind: "ArchivedThread",
      code: 50083,
    });
  });
});

describe("CoreDiscordPort guild member state (M9)", () => {
  it("listGuildMembers passes limit and after, maps roles and bot", async () => {
    const { api, guilds } = fakeApi();
    const r = await new CoreDiscordPort(api).listGuildMembers("g", "10", 1000);
    expect(guilds.getMembers).toHaveBeenCalledWith("g", { limit: 1000, after: "10" });
    expect(r).toEqual({
      ok: true,
      value: [
        { userId: "11", roleIds: ["700", "701"], bot: false },
        { userId: "12", roleIds: [], bot: true },
      ],
    });
  });

  it("listGuildMembers without a cursor sends no `after`", async () => {
    const { api, guilds } = fakeApi();
    await new CoreDiscordPort(api).listGuildMembers("g", undefined, 1000);
    expect(guilds.getMembers).toHaveBeenCalledWith("g", { limit: 1000 });
  });

  it("403 → Permanent, 5xx → Transient", async () => {
    const { api, guilds } = fakeApi();
    guilds.getMembers.mockRejectedValueOnce(apiError(50001, 403));
    expect(await new CoreDiscordPort(api).listGuildMembers("g", undefined, 1000)).toMatchObject({
      ok: false,
      class: "Permanent",
      code: 50001,
    });
    guilds.getRoles.mockRejectedValueOnce(new HTTPError(503, "x", "GET", "/x", { body: {} }));
    expect(await new CoreDiscordPort(api).getGuildRoleIds("g")).toMatchObject({
      ok: false,
      class: "Transient",
      code: 503,
    });
  });

  it("getGuildRoleIds maps ids", async () => {
    const { api, guilds } = fakeApi();
    expect(await new CoreDiscordPort(api).getGuildRoleIds("g")).toEqual({
      ok: true,
      value: ["500", "700"],
    });
    expect(guilds.getRoles).toHaveBeenCalledWith("g");
  });
});

describe("commands", () => {
  it("Track Seen is a guild-install message command with no default_member_permissions", () => {
    expect(trackSeenCommand).toEqual({
      name: "Track Seen",
      type: 3,
      integration_types: [0],
      contexts: [0],
    });
    expect(trackSeenCommand).not.toHaveProperty("default_member_permissions");
  });

  it("guild registration strips global-only fields", () => {
    // M9 adds /autotrack after Track Seen (shape pinned in commands.test.ts); Track Seen is unchanged.
    expect(commandsFor("guild")[0]).toEqual({ name: "Track Seen", type: 3 });
    expect(commandsFor("global")[0]).toEqual(trackSeenCommand);
    expect(commandsFor("guild")).toHaveLength(2);
  });
});
