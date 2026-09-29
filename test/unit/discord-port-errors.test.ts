import { DiscordAPIError, HTTPError } from "@discordjs/rest";
import { describe, expect, it } from "vitest";
import {
  classifyLookupError,
  mapCreateCompanionError,
  mapEditError,
  toHistoryMessage,
  toSourceInfo,
} from "../../src/discord/discord-port.ts";

function apiError(code: number, status = 400, errors?: Record<string, unknown>) {
  const raw = { code, message: "x", ...(errors ? { errors } : {}) };
  return new DiscordAPIError(
    raw as ConstructorParameters<typeof DiscordAPIError>[0],
    code,
    status,
    "POST",
    "/x",
    { body: {} },
  );
}

describe("mapCreateCompanionError", () => {
  it("10008 and 50035 with a message_reference error → SourceMissing", () => {
    expect(mapCreateCompanionError(apiError(10008, 404))).toEqual({ kind: "SourceMissing" });
    const form = apiError(50035, 400, {
      message_reference: {
        _errors: [{ code: "REPLIES_UNKNOWN_MESSAGE", message: "Unknown message" }],
      },
    });
    expect(mapCreateCompanionError(form)).toEqual({ kind: "SourceMissing" });
  });

  it("50035 without a message_reference error → Unknown with code", () => {
    const form = apiError(50035, 400, { components: { _errors: [{ code: "X", message: "bad" }] } });
    expect(mapCreateCompanionError(form)).toEqual({ kind: "Unknown", code: 50035 });
  });

  it.each([
    [160002, { kind: "MissingPermissions", permissions: ["READ_MESSAGE_HISTORY"] }],
    [50013, { kind: "MissingPermissions", permissions: ["VIEW_CHANNEL", "SEND_MESSAGES"] }],
    [10003, { kind: "ChannelMissing" }],
    [50083, { kind: "ThreadUnavailable" }],
    [160005, { kind: "ThreadUnavailable" }],
  ])("%i → %o", (code, expected) => {
    expect(mapCreateCompanionError(apiError(code))).toEqual(expected);
  });

  it("network errors → Unknown", () => {
    expect(mapCreateCompanionError(new Error("ECONNRESET"))).toEqual({ kind: "Unknown" });
  });
});

describe("mapEditError", () => {
  it.each([
    [10008, "MessageMissing"],
    [10003, "ChannelMissing"],
    [50083, "ArchivedThread"],
    [50001, "Forbidden"],
    [50013, "Forbidden"],
  ])("%i → %s", (code, kind) => {
    expect(mapEditError(apiError(code))).toEqual({ ok: false, kind, code });
  });

  it("5xx / network → Transient", () => {
    expect(
      mapEditError(new HTTPError(503, "Service Unavailable", "PATCH", "/x", { body: {} })),
    ).toEqual({ ok: false, kind: "Transient" });
  });
});

describe("classifyLookupError", () => {
  it("maps NotFound / Permanent / Transient", () => {
    expect(classifyLookupError(apiError(10008, 404))).toBe("NotFound");
    expect(classifyLookupError(apiError(50001, 403))).toBe("Permanent");
    expect(classifyLookupError(apiError(10003, 404))).toBe("Permanent");
    expect(classifyLookupError(new HTTPError(500, "x", "GET", "/x", { body: {} }))).toBe(
      "Transient",
    );
    expect(classifyLookupError(new Error("timeout"))).toBe("Transient");
  });
});

describe("REST message mapping", () => {
  const base = {
    id: "1300000000000000005",
    channel_id: "600",
    type: 19,
    author: { id: "11" },
    message_reference: { message_id: "1299999999999999999" },
    reactions: [
      { emoji: { id: null, name: "👍" }, count_details: { normal: 2, burst: 1 } },
      { emoji: { id: "123", name: "party" }, count_details: { normal: 1, burst: 0 } },
    ],
  };

  it("source info exposes emoji keys, REST emoji form and per-type counts", () => {
    expect(toSourceInfo(base as never)).toEqual({
      id: base.id,
      authorId: "11",
      reactions: [
        { emojiKey: "👍", apiEmoji: "👍", normal: 2, burst: 1 },
        { emojiKey: "123", apiEmoji: "party:123", normal: 1, burst: 0 },
      ],
    });
  });

  it("history messages run through the same message adapter", () => {
    expect(toHistoryMessage(base as never).signals).toEqual([
      expect.objectContaining({
        t: "MESSAGE",
        replyToMessageId: "1299999999999999999",
        guildId: null,
      }),
    ]);
  });
});
