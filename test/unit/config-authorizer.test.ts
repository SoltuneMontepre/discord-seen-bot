import { describe, expect, it } from "vitest";
import { ConfigAuthorizer } from "../../src/app/config-authorizer.ts";

const actor = (guildId: string | undefined, memberPermissions = "0") => ({
  userId: "1",
  guildId,
  memberPermissions,
});

describe("ConfigAuthorizer (M9: any guild member, tenant-isolated)", () => {
  const auth = new ConfigAuthorizer();

  it("an ordinary member without permissions is authorized for every action in their guild", () => {
    for (const action of [
      "policy.create",
      "policy.list",
      "policy.edit",
      "policy.delete",
    ] as const) {
      expect(auth.authorize(actor("500"), action, { guildId: "500", channelId: "600" })).toEqual({
        ok: true,
      });
    }
  });

  it("a different guild (or no guild) is rejected", () => {
    expect(auth.authorize(actor("501"), "policy.edit", { guildId: "500" }).ok).toBe(false);
    expect(auth.authorize(actor(undefined), "policy.list", { guildId: "500" }).ok).toBe(false);
  });
});
