import { describe, expect, it } from "vitest";
import {
  guildCreateToEvent,
  guildDeleteToMemberEvent,
  memberRemoveToEvent,
  memberUpsertToEvent,
  roleDeleteToEvent,
} from "../../src/discord/adapters/member.ts";
import { messageToAutoTrackCandidate } from "../../src/discord/adapters/message.ts";
import {
  GUILD_ID,
  guildMemberRemove,
  guildMemberUpdate,
  guildRoleDelete,
  messageCreateForward,
  messageCreateMentions,
} from "../fixtures/gateway.ts";

const BOTH = { mentionAutoTrack: true, roleTargets: true };
const cand = (d: object, flags = BOTH) =>
  messageToAutoTrackCandidate(d as Parameters<typeof messageToAutoTrackCandidate>[0], flags);

describe("messageToAutoTrackCandidate", () => {
  it("top-level human message in a text channel → candidate (bots removed)", () => {
    expect(cand(messageCreateMentions)).toEqual({
      guildId: GUILD_ID,
      channelId: "600",
      channelType: 0,
      messageId: "1300000000000000010",
      authorId: "11",
      explicitUserIds: ["21", "22"],
      mentionedRoleIds: ["700"],
    });
  });

  it.each([
    ["reply (type 19)", { type: 19 }],
    ["bot author", { author: { id: "11", bot: true } }],
    ["webhook", { webhook_id: "77" }],
    ["DM (no guild_id)", { guild_id: undefined }],
    ["missing channel_type", { channel_type: undefined }],
    ["voice text channel_type 2", { channel_type: 2 }],
    ["system message type 7", { type: 7 }],
  ])("%s → null", (_n, patch) => {
    expect(cand({ ...messageCreateMentions, ...patch })).toBeNull();
  });

  it("the bot's own status card (bot author reply) → null", () => {
    expect(
      cand({ ...messageCreateMentions, type: 19, author: { id: "999", bot: true } }),
    ).toBeNull();
  });

  it.each([
    ["announcement 5", 5],
    ["announcement thread 10", 10],
    ["public thread / forum post 11", 11],
    ["private thread 12", 12],
  ])("%s → candidate", (_n, channelType) => {
    expect(cand({ ...messageCreateMentions, channel_type: channelType })?.channelType).toBe(
      channelType,
    );
  });

  it("@everyone (mention_everyone, no ids) → empty sources, still a candidate", () => {
    expect(
      cand({ ...messageCreateMentions, mentions: [], mention_roles: [], mention_everyone: true }),
    ).toMatchObject({ explicitUserIds: [], mentionedRoleIds: [] });
  });

  it("<@&guildId> is removed from role mentions", () => {
    expect(
      cand({ ...messageCreateMentions, mention_roles: [GUILD_ID, "700"] })?.mentionedRoleIds,
    ).toEqual(["700"]);
  });

  it("the author mentioning themself is removed; duplicates collapse", () => {
    expect(
      cand({
        ...messageCreateMentions,
        mentions: [{ id: "11" }, { id: "21" }, { id: "21" }],
        mention_roles: ["700", "700"],
      }),
    ).toMatchObject({ explicitUserIds: ["21"], mentionedRoleIds: ["700"] });
  });

  it("missing mention arrays are treated as empty", () => {
    const { mentions: _m, mention_roles: _r, ...rest } = messageCreateMentions;
    expect(cand(rest)).toMatchObject({ explicitUserIds: [], mentionedRoleIds: [] });
  });

  it("mentions off → explicitUserIds [] and mentionedRoleIds []", () => {
    expect(
      cand(messageCreateMentions, { mentionAutoTrack: false, roleTargets: true }),
    ).toMatchObject({
      explicitUserIds: [],
      mentionedRoleIds: [],
    });
  });

  it("mentions on + roles off → roles []", () => {
    expect(
      cand(messageCreateMentions, { mentionAutoTrack: true, roleTargets: false }),
    ).toMatchObject({
      explicitUserIds: ["21", "22"],
      mentionedRoleIds: [],
    });
  });

  it("forward: snapshot-only ids ignored, outer-only kept, overlap dropped", () => {
    expect(cand(messageCreateForward)).toMatchObject({
      explicitUserIds: ["21"],
      mentionedRoleIds: ["700"],
    });
  });

  it("forward detected by HAS_SNAPSHOT flag alone, or by reference type alone", () => {
    const byFlag = { ...messageCreateForward, message_reference: undefined };
    const byRef = { ...messageCreateForward, flags: 0 };
    expect(cand(byFlag)?.explicitUserIds).toEqual(["21"]);
    expect(cand(byRef)?.explicitUserIds).toEqual(["21"]);
  });

  it("forward candidate object contains no snapshot-derived fields", () => {
    const c = cand(messageCreateForward);
    expect(Object.keys(c ?? {}).sort()).toEqual([
      "authorId",
      "channelId",
      "channelType",
      "explicitUserIds",
      "guildId",
      "mentionedRoleIds",
      "messageId",
    ]);
    expect(JSON.stringify(c)).not.toMatch(/23|702|content|snapshot/);
  });
});

describe("member-state adapters", () => {
  it("member UPDATE maps roles and bot (bot absent → false)", () => {
    expect(memberUpsertToEvent(guildMemberUpdate)).toEqual({
      t: "member_upsert",
      guildId: GUILD_ID,
      userId: "21",
      roleIds: ["700", "701"],
      bot: false,
    });
  });

  it("member ADD for an existing member maps identically; bot flag kept", () => {
    expect(
      memberUpsertToEvent({ ...guildMemberUpdate, user: { id: "31", bot: true } }),
    ).toMatchObject({ userId: "31", bot: true });
  });

  it("member upsert without user or guild → null", () => {
    expect(memberUpsertToEvent({ ...guildMemberUpdate, user: undefined })).toBeNull();
    expect(memberUpsertToEvent({ ...guildMemberUpdate, guild_id: undefined })).toBeNull();
  });

  it("REMOVE maps", () => {
    expect(memberRemoveToEvent(guildMemberRemove)).toEqual({
      t: "member_remove",
      guildId: GUILD_ID,
      userId: "21",
    });
  });

  it("role delete, guild create, guild delete (unavailable only)", () => {
    expect(roleDeleteToEvent(guildRoleDelete)).toEqual({
      t: "role_delete",
      guildId: GUILD_ID,
      roleId: "700",
    });
    expect(guildCreateToEvent({ id: GUILD_ID })).toEqual({
      t: "guild_available",
      guildId: GUILD_ID,
    });
    expect(guildDeleteToMemberEvent({ id: GUILD_ID, unavailable: true })).toEqual({
      t: "guild_unavailable",
      guildId: GUILD_ID,
    });
    // removal goes through the lifecycle hook (GUILD_REMOVED signal), not this adapter
    expect(guildDeleteToMemberEvent({ id: GUILD_ID })).toBeNull();
  });
});
