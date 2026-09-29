import { describe, expect, it } from "vitest";
import {
  memberPayloadShape,
  messagePayloadShape,
} from "../../src/discord/adapters/payload-shape.ts";

describe("payload shapes for SEEN_DEBUG_PAYLOADS (ids and metadata only, never content)", () => {
  it("message shape keeps the fields the M9 ⚠ checks need and drops all content", () => {
    const raw = {
      id: "10",
      channel_id: "20",
      guild_id: "30",
      channel_type: 11,
      type: 0,
      flags: 1 << 14,
      author: { id: "40", bot: false, username: "secret-name" },
      content: "top secret text",
      embeds: [{ title: "x" }],
      attachments: [{ url: "y" }],
      mentions: [{ id: "50", bot: true, username: "b" }, { id: "51" }],
      mention_roles: ["60"],
      mention_everyone: false,
      message_reference: { type: 1, message_id: "70", channel_id: "80", guild_id: "30" },
      message_snapshots: [
        {
          message: {
            content: "snap text",
            embeds: [],
            mentions: [{ id: "52" }],
            mention_roles: ["61"],
          },
        },
      ],
    };
    const shape = messagePayloadShape(raw);
    expect(shape).toEqual({
      id: "10",
      guild_id: "30",
      channel_id: "20",
      channel_type: 11,
      type: 0,
      flags: 16384,
      author: { id: "40", bot: false },
      webhook: false,
      content_present: true,
      mentions: [
        { id: "50", bot: true },
        { id: "51", bot: null },
      ],
      mention_roles: ["60"],
      mention_everyone: false,
      message_reference: { type: 1, message_id: "70", channel_id: "80" },
      snapshots: [{ mentions: ["52"], mention_roles: ["61"] }],
    });
    expect(JSON.stringify(shape)).not.toMatch(/secret|snap text|title|url/);
  });

  it("missing fields are explicit (channel_type 'missing', no reference, no snapshots)", () => {
    expect(
      messagePayloadShape({
        id: "1",
        channel_id: "2",
        type: 19,
        author: { id: "3" },
        webhook_id: "9",
      }),
    ).toMatchObject({
      guild_id: null,
      channel_type: "missing",
      flags: 0,
      webhook: true,
      content_present: false,
      mentions: [],
      mention_roles: [],
      mention_everyone: null,
      message_reference: null,
      snapshots: [],
    });
  });

  it("member shape: guild, user, bot flag presence and the full role list", () => {
    const member = {
      guild_id: "1",
      user: { id: "2", username: "n", bot: true },
      roles: ["3", "4"],
      nick: "x",
    };
    expect(memberPayloadShape(member)).toEqual({
      guild_id: "1",
      user_id: "2",
      bot: true,
      roles: ["3", "4"],
      role_count: 2,
    });
    expect(memberPayloadShape({ guild_id: "1", user: { id: "2" } })).toEqual({
      guild_id: "1",
      user_id: "2",
      bot: null,
      roles: null,
      role_count: null,
    });
  });
});
