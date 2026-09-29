import { GatewayIntentBits } from "@discordjs/core";
import { describe, expect, it } from "vitest";
import { assertAllowedIntents, buildIntents } from "../../src/discord/intents.ts";

const MESSAGE_CONTENT = 1 << 15;
const GUILD_PRESENCES = 1 << 8;

describe("buildIntents (flag matrix)", () => {
  it.each([
    [{ mentionAutoTrack: false, roleTargets: false }, 3585],
    [{ mentionAutoTrack: true, roleTargets: false }, 3585],
    [{ mentionAutoTrack: false, roleTargets: true }, 3587],
    [{ mentionAutoTrack: true, roleTargets: true }, 3587],
  ])("matrix %o → %i", (features, expected) => {
    expect(buildIntents(features)).toBe(expected);
  });

  it("never includes MESSAGE_CONTENT or GUILD_PRESENCES in any combination", () => {
    for (const mentionAutoTrack of [false, true]) {
      for (const roleTargets of [false, true]) {
        const intents = buildIntents({ mentionAutoTrack, roleTargets });
        expect(intents & MESSAGE_CONTENT).toBe(0);
        expect(intents & GUILD_PRESENCES).toBe(0);
      }
    }
  });
});

describe("assertAllowedIntents", () => {
  it("accepts the built intents for each flag setting", () => {
    expect(() => assertAllowedIntents(3585, { roleTargets: false })).not.toThrow();
    expect(() => assertAllowedIntents(3587, { roleTargets: true })).not.toThrow();
  });

  it("throws for GuildMembers when roleTargets=false", () => {
    expect(() =>
      assertAllowedIntents(3585 | GatewayIntentBits.GuildMembers, { roleTargets: false }),
    ).toThrow(/GUILD_MEMBERS/);
  });

  it("throws for MessageContent and GuildPresences always", () => {
    for (const roleTargets of [false, true]) {
      expect(() => assertAllowedIntents(3587 | MESSAGE_CONTENT, { roleTargets })).toThrow(
        /MESSAGE_CONTENT/,
      );
      expect(() => assertAllowedIntents(3587 | GUILD_PRESENCES, { roleTargets })).toThrow(
        /GUILD_PRESENCES/,
      );
    }
  });
});
