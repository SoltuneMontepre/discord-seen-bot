import { PermissionFlagsBits } from "@discordjs/core";
import { describe, expect, it } from "vitest";
import {
  BOT_PERMISSIONS,
  isManager,
  missingAppPermissions,
} from "../../src/discord/permissions.ts";

const bits = (...flags: bigint[]) => flags.reduce((a, b) => a | b, 0n).toString();

describe("permissions", () => {
  it("install permission integer matches the plan", () => {
    expect(BOT_PERMISSIONS).toBe(274877975552n);
  });

  it("channel vs thread requirements", () => {
    const channelOk = bits(
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    );
    expect(missingAppPermissions(channelOk, false)).toEqual([]);
    expect(missingAppPermissions(channelOk, true)).toEqual(["SEND_MESSAGES_IN_THREADS"]);
    expect(missingAppPermissions(bits(PermissionFlagsBits.ViewChannel), false)).toEqual([
      "SEND_MESSAGES",
      "READ_MESSAGE_HISTORY",
    ]);
    expect(missingAppPermissions(bits(PermissionFlagsBits.Administrator), true)).toEqual([]);
  });

  it("manager check: creator, ManageMessages, Administrator; others denied", () => {
    expect(isManager("1", "1", undefined)).toBe(true);
    expect(isManager("2", "1", bits(PermissionFlagsBits.ManageMessages))).toBe(true);
    expect(isManager("2", "1", bits(PermissionFlagsBits.Administrator))).toBe(true);
    expect(isManager("2", "1", bits(PermissionFlagsBits.SendMessages))).toBe(false);
    expect(isManager("2", "1", undefined)).toBe(false);
  });
});
