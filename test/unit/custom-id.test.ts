import { describe, expect, it } from "vitest";
import { decodeCustomId, encodeCustomId } from "../../src/discord/custom-id.ts";

describe("custom-id", () => {
  it.each([
    { action: "ack", trackedId: 42 },
    { action: "manage", trackedId: 1 },
    { action: "undo", trackedId: 9 },
    { action: "targets", trackedId: 7 },
    { action: "stop", trackedId: 3 },
    { action: "pick", sourceMessageId: "12345678901234567890" },
  ] as const)("round-trips %o within 100 chars", (id) => {
    const raw = encodeCustomId(id);
    expect(raw.length).toBeLessThanOrEqual(100);
    expect(raw.startsWith("sb1:")).toBe(true);
    expect(decodeCustomId(raw)).toEqual(id);
  });

  it.each([
    "sb0:ack:1",
    "sb2:ack:1",
    "sb1:ack",
    "sb1:ack:1:2",
    "sb1:nope:1",
    "sb1:ack:abc",
    "sb1:ack:0",
    "sb1:ack:-1",
    "other",
    `sb1:ack:${"9".repeat(200)}`,
  ])("rejects %s", (raw) => {
    expect(decodeCustomId(raw)).toBeNull();
  });
});
