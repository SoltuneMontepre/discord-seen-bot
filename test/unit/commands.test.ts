import { describe, expect, it } from "vitest";
import { autotrackCommand, commandsFor, trackSeenCommand } from "../../src/discord/commands.ts";

describe("commands (M9)", () => {
  it("Track Seen is unchanged", () => {
    expect(trackSeenCommand).toEqual({
      name: "Track Seen",
      type: 3,
      integration_types: [0],
      contexts: [0],
    });
  });

  it("/autotrack shape is exact", () => {
    expect(autotrackCommand).toEqual({
      name: "autotrack",
      description: "Configure role-based auto-tracking for a channel",
      type: 1,
      integration_types: [0],
      contexts: [0],
      options: [
        {
          type: 1,
          name: "create",
          description: "Create an auto-track policy for a channel",
          options: [
            {
              type: 7,
              name: "channel",
              description: "Text or announcement channel",
              required: true,
              channel_types: [0, 5],
            },
            { type: 3, name: "name", description: "Policy name", required: true, max_length: 100 },
            {
              type: 8,
              name: "role",
              description: "Members of this role become targets",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "list",
          description: "List a channel's auto-track policies",
          options: [
            {
              type: 7,
              name: "channel",
              description: "Text or announcement channel (default: this one)",
              required: false,
              channel_types: [0, 5],
            },
            { type: 4, name: "page", description: "Page number", required: false, min_value: 1 },
          ],
        },
      ],
    });
  });

  it("no default_member_permissions on any command", () => {
    for (const c of commandsFor("global"))
      expect(c).not.toHaveProperty("default_member_permissions");
  });

  it("global registers both; guild scope strips integration_types/contexts", () => {
    expect(commandsFor("global")).toEqual([trackSeenCommand, autotrackCommand]);
    const guild = commandsFor("guild");
    expect(guild.map((c) => c.name)).toEqual(["Track Seen", "autotrack"]);
    for (const c of guild) {
      expect(c).not.toHaveProperty("integration_types");
      expect(c).not.toHaveProperty("contexts");
    }
  });
});
