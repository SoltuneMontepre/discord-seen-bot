/** Hand-written gateway payload fixtures. IDs and metadata only — no content fields are needed. */
export const GUILD_ID = "500";
export const CHANNEL_ID = "600";

export const messageCreatePlain = {
  id: "1300000000000000001",
  channel_id: CHANNEL_ID,
  guild_id: GUILD_ID,
  type: 0,
  author: { id: "11", username: "b", bot: false },
  content: "",
  mentions: [],
};

export const messageCreateReply = {
  ...messageCreatePlain,
  id: "1300000000000000002",
  type: 19,
  message_reference: {
    type: 0,
    message_id: "1299999999999999999",
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
  },
};

export const reactionAdd = {
  user_id: "11",
  channel_id: CHANNEL_ID,
  message_id: "1299999999999999999",
  guild_id: GUILD_ID,
  member: { user: { id: "11", bot: false }, roles: [] },
  emoji: { id: null, name: "👍" },
  burst: false,
  type: 0,
};

export const typingStart = {
  channel_id: CHANNEL_ID,
  guild_id: GUILD_ID,
  user_id: "11",
  timestamp: 1_780_000_000,
  member: { user: { id: "11", bot: false }, roles: [] },
};

// ------------------------------------------------------------------ M9 auto-track fixtures

/** Top-level human message in a text channel, mentioning users 21/22 and role 700 (+ bot 31). */
export const messageCreateMentions = {
  ...messageCreatePlain,
  id: "1300000000000000010",
  channel_type: 0,
  mentions: [
    { id: "21", username: "an", bot: false },
    { id: "22", username: "binh" },
    { id: "31", username: "somebot", bot: true },
  ],
  mention_roles: ["700"],
  mention_everyone: false,
};

/** Forward (message_reference.type 1 + HAS_SNAPSHOT) whose outer mentions overlap the snapshot. */
export const messageCreateForward = {
  ...messageCreateMentions,
  id: "1300000000000000011",
  flags: 1 << 14,
  mentions: [
    { id: "21", username: "an" }, // forwarder's own
    { id: "22", username: "binh" }, // also in the snapshot → ambiguous
  ],
  mention_roles: ["700", "701"], // 701 also in the snapshot → ambiguous
  message_reference: { type: 1, message_id: "1299999999999999990", channel_id: "601" },
  message_snapshots: [
    {
      message: {
        content: "",
        mentions: [
          { id: "22", username: "binh" },
          { id: "23", username: "kim" },
        ],
        mention_roles: ["701", "702"],
      },
    },
  ],
};

export const guildMemberUpdate = {
  guild_id: GUILD_ID,
  user: { id: "21", username: "an" },
  roles: ["700", "701"],
  nick: null,
};

export const guildMemberRemove = { guild_id: GUILD_ID, user: { id: "21", username: "an" } };
export const guildRoleDelete = { guild_id: GUILD_ID, role_id: "700" };
