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
