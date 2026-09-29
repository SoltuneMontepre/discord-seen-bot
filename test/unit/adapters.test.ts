import type {
  GatewayMessageReactionAddDispatchData,
  GatewayMessageReactionRemoveDispatchData,
  GatewayTypingStartDispatchData,
} from "@discordjs/core";
import { describe, expect, it } from "vitest";
import {
  channelDeleteToSignal,
  guildDeleteToSignal,
  messageDeleteBulkToSignal,
  messageDeleteToSignal,
  threadDeleteToSignal,
  threadUpdateToSignal,
} from "../../src/discord/adapters/lifecycle.ts";
import { messageToSignal } from "../../src/discord/adapters/message.ts";
import {
  apiEmojiOf,
  reactionAddToSignal,
  reactionRemoveEmojiToSignal,
  reactionRemoveToSignal,
} from "../../src/discord/adapters/reaction.ts";
import { typingToSignal } from "../../src/discord/adapters/typing.ts";
import { timestampOf } from "../../src/domain/snowflake.ts";
import * as F from "../fixtures/gateway.ts";

const asReaction = (x: unknown) => x as GatewayMessageReactionAddDispatchData;

describe("message adapter", () => {
  it("plain message → MESSAGE without replyToMessageId, time from the snowflake", () => {
    expect(messageToSignal(F.messageCreatePlain, true)).toEqual({
      t: "MESSAGE",
      guildId: F.GUILD_ID,
      channelId: F.CHANNEL_ID,
      messageId: F.messageCreatePlain.id,
      authorId: "11",
      occurredAt: timestampOf(F.messageCreatePlain.id),
    });
  });

  it("reply (type 19) sets replyToMessageId from message_reference", () => {
    expect(messageToSignal(F.messageCreateReply, true)).toMatchObject({
      replyToMessageId: "1299999999999999999",
    });
  });

  it("a message_reference on a non-reply type (e.g. forward) is not a reply", () => {
    const forward = { ...F.messageCreateReply, type: 0 };
    expect(messageToSignal(forward, true)).not.toHaveProperty("replyToMessageId");
  });

  it.each([
    ["bot author", { ...F.messageCreatePlain, author: { id: "9", bot: true } }],
    ["webhook", { ...F.messageCreatePlain, webhook_id: "77" }],
    ["system message (pin)", { ...F.messageCreatePlain, type: 6 }],
    ["slash command response", { ...F.messageCreatePlain, type: 20 }],
    ["DM (no guild_id)", { ...F.messageCreatePlain, guild_id: undefined }],
  ])("drops %s", (_n, m) => {
    expect(messageToSignal(m as typeof F.messageCreatePlain, true)).toBeNull();
  });

  it("history messages (no guild_id) are accepted when requireGuild=false", () => {
    const { guild_id: _g, ...history } = F.messageCreatePlain;
    expect(messageToSignal(history, false)).toMatchObject({ t: "MESSAGE", guildId: null });
  });
});

describe("reaction adapter", () => {
  it("add → REACTION_ADD with no occurrence time; unicode key", () => {
    const s = reactionAddToSignal(asReaction(F.reactionAdd));
    expect(s).toEqual({
      t: "REACTION_ADD",
      guildId: F.GUILD_ID,
      channelId: F.CHANNEL_ID,
      messageId: F.reactionAdd.message_id,
      userId: "11",
      reactionKey: "👍|0",
    });
    expect(s).not.toHaveProperty("occurredAt");
  });

  it("burst reactions and custom emoji keys", () => {
    const s = reactionAddToSignal(
      asReaction({ ...F.reactionAdd, burst: true, type: 1, emoji: { id: "123", name: "party" } }),
    );
    expect(s).toMatchObject({ reactionKey: "123|1" });
    expect(apiEmojiOf({ id: "123", name: "party" })).toBe("party:123");
    expect(apiEmojiOf({ id: null, name: "👍" })).toBe("👍");
  });

  it("falls back to `burst` when `type` is absent", () => {
    const { type: _t, ...noType } = F.reactionAdd;
    expect(reactionAddToSignal(asReaction({ ...noType, burst: true }))).toMatchObject({
      reactionKey: "👍|1",
    });
  });

  it("drops bot reactions and DMs", () => {
    expect(
      reactionAddToSignal(
        asReaction({ ...F.reactionAdd, member: { user: { id: "9", bot: true } } }),
      ),
    ).toBeNull();
    expect(reactionAddToSignal(asReaction({ ...F.reactionAdd, guild_id: undefined }))).toBeNull();
  });

  it("remove and remove-emoji", () => {
    const { member: _m, ...removeBase } = F.reactionAdd;
    const remove = removeBase as unknown as GatewayMessageReactionRemoveDispatchData;
    expect(reactionRemoveToSignal(remove)).toMatchObject({
      t: "REACTION_REMOVE",
      reactionKey: "👍|0",
    });
    expect(
      reactionRemoveEmojiToSignal({
        channel_id: F.CHANNEL_ID,
        guild_id: F.GUILD_ID,
        message_id: "1",
        emoji: { id: null, name: "👍" },
      }),
    ).toEqual({
      t: "REACTION_REMOVE_EMOJI",
      channelId: F.CHANNEL_ID,
      messageId: "1",
      emojiKey: "👍",
    });
  });
});

describe("typing adapter", () => {
  it("converts seconds to milliseconds", () => {
    expect(typingToSignal(F.typingStart as unknown as GatewayTypingStartDispatchData)).toEqual({
      t: "TYPING",
      guildId: F.GUILD_ID,
      channelId: F.CHANNEL_ID,
      userId: "11",
      occurredAt: 1_780_000_000_000,
    });
  });

  it("drops bots and DMs", () => {
    const bot = { ...F.typingStart, member: { user: { id: "9", bot: true }, roles: [] } };
    expect(typingToSignal(bot as unknown as GatewayTypingStartDispatchData)).toBeNull();
    const dm = { ...F.typingStart, guild_id: undefined };
    expect(typingToSignal(dm as unknown as GatewayTypingStartDispatchData)).toBeNull();
  });
});

describe("lifecycle adapters", () => {
  it("delete and bulk delete map to MESSAGES_DELETED", () => {
    expect(messageDeleteToSignal({ id: "1", channel_id: "c", guild_id: "g" })).toEqual({
      t: "MESSAGES_DELETED",
      channelId: "c",
      messageIds: ["1"],
    });
    expect(messageDeleteBulkToSignal({ ids: ["1", "2"], channel_id: "c", guild_id: "g" })).toEqual({
      t: "MESSAGES_DELETED",
      channelId: "c",
      messageIds: ["1", "2"],
    });
  });

  it("channel/thread delete, thread unarchive, guild removal vs outage", () => {
    expect(channelDeleteToSignal({ id: "c" } as never)).toEqual({
      t: "CHANNEL_DELETED",
      channelId: "c",
    });
    expect(threadDeleteToSignal({ id: "t" } as never)).toEqual({
      t: "CHANNEL_DELETED",
      channelId: "t",
    });
    expect(
      threadUpdateToSignal({ id: "t", thread_metadata: { archived: false } } as never),
    ).toEqual({ t: "THREAD_UNARCHIVED", threadId: "t" });
    expect(
      threadUpdateToSignal({ id: "t", thread_metadata: { archived: true } } as never),
    ).toBeNull();
    expect(guildDeleteToSignal({ id: "g", unavailable: true })).toBeNull();
    expect(guildDeleteToSignal({ id: "g" } as never)).toEqual({ t: "GUILD_REMOVED", guildId: "g" });
  });
});
