import { describe, expect, it } from "vitest";
import {
  buildCardBody,
  buildOrphanBody,
  cardRenderer,
  countComponents,
} from "../../src/discord/render/card.ts";
import { CARD_FOOTER, STATE_HEADINGS } from "../../src/discord/render/text.ts";
import type { ProjectionRow, TrackedMessage } from "../../src/domain/types.ts";
import { HOUR, MIN, T0 } from "../helpers/domain.ts";

const tracked: TrackedMessage = {
  id: 7,
  guildId: "500",
  channelId: "600",
  parentChannelId: null,
  sourceMessageId: "700",
  sourceAuthorId: "100",
  sourceCreatedAt: T0 - MIN,
  statusMessageId: "800",
  creatorUserId: "100",
  createdAt: T0,
  weakWindowEndsAt: T0 + 2 * HOUR,
  expiresAt: T0 + 7 * 24 * HOUR,
  initialBackfillAt: null,
  stoppedAt: null,
  stopReason: null,
  stoppedByUserId: null,
  renderedHash: null,
};

const rows: ProjectionRow[] = [
  { userId: "11", state: "CONFIRMED", basis: { kind: "EXPLICIT_ACK", occurredAt: T0 + MIN } },
  { userId: "12", state: "INTERACTED", basis: { kind: "DIRECT_REPLY", occurredAt: T0 + 2 * MIN } },
  { userId: "13", state: "INTERACTED", basis: { kind: "DIRECT_REACTION", occurredAt: null } },
  { userId: "14", state: "LIKELY", basis: { kind: "TYPING_AFTER", occurredAt: T0 + 3 * MIN } },
  {
    userId: "15",
    state: "LIKELY",
    basis: { kind: "CHANNEL_MESSAGE_AFTER", occurredAt: T0 + 4 * MIN },
  },
  { userId: "16", state: "UNKNOWN", basis: null },
];

type Node = {
  type: number;
  content?: string;
  components?: Node[];
  custom_id?: string;
  label?: string;
};

function texts(body: { components: unknown[] }): string[] {
  const out: string[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (typeof n.content === "string") out.push(n.content);
      if (n.components) walk(n.components);
    }
  };
  walk(body.components as Node[]);
  return out;
}

function buttons(body: { components: unknown[] }): Node[] {
  const out: Node[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === 2) out.push(n);
      if (n.components) walk(n.components);
    }
  };
  walk(body.components as Node[]);
  return out;
}

/** Group text blocks keyed by their heading line. */
function groups(body: { components: unknown[] }) {
  const map = new Map<string, string[]>();
  for (const block of texts(body)) {
    const [first, ...rest] = block.split("\n");
    if (first && Object.values(STATE_HEADINGS).includes(first as never)) map.set(first, rest);
  }
  return map;
}

describe("card rendering", () => {
  const body = buildCardBody({ tracked, rows });
  const g = groups(body);

  it("uses exact state headings", () => {
    expect([...g.keys()]).toEqual([
      "✅ **Confirmed**",
      "💬 **Interacted**",
      "👁 **Likely seen**",
      "○ **No signal**",
    ]);
  });

  it("renders every user row with its exact state template", () => {
    for (const line of g.get(STATE_HEADINGS.CONFIRMED) ?? [])
      expect(line).toMatch(/^<@\d+> · <t:\d+:[tf]>$/);
    const interacted = g.get(STATE_HEADINGS.INTERACTED) ?? [];
    expect(interacted).toHaveLength(2);
    for (const line of interacted)
      expect(line).toMatch(/^(<@\d+> · replied · <t:\d+:[tf]>|<@\d+> · reacted)$/);
    for (const line of g.get(STATE_HEADINGS.LIKELY) ?? [])
      expect(line).toMatch(/^<@\d+> · (typing in channel|posted in channel) · <t:\d+:[tf]>$/);
    for (const line of g.get(STATE_HEADINGS.UNKNOWN) ?? []) expect(line).toMatch(/^<@\d+>$/);
  });

  it("never renders a time for a reaction", () => {
    const reacted = (g.get(STATE_HEADINGS.INTERACTED) ?? []).find((l) => l.includes("reacted"));
    expect(reacted).toBe("<@13> · reacted");
    expect(reacted).not.toContain("<t:");
  });

  it("confines certainty vocabulary to the confirmed heading, header count and footer", () => {
    const all = texts(body).join("\n");
    const allowedSeen = ["Seen status", "Likely seen", "I've seen this"];
    const buttonLabels = buttons(body).map((b) => b.label ?? "");
    let stripped = [all, ...buttonLabels].join("\n");
    for (const phrase of allowedSeen) stripped = stripped.replaceAll(phrase, "");
    expect(stripped).not.toMatch(/\bseen\b/i);

    const confirmedLines = all.split("\n").filter((l) => /confirmed/i.test(l));
    expect(confirmedLines).toEqual([
      expect.stringMatching(/ · 1\/6 confirmed$/),
      STATE_HEADINGS.CONFIRMED,
    ]);
    const ackLines = all.split("\n").filter((l) => /acknowledg/i.test(l));
    expect(ackLines).toEqual([CARD_FOOTER]);

    const userRows = [...g.values()].flat();
    for (const row of userRows) expect(row).not.toMatch(/\b(read|acknowledged|seen|confirmed)\b/i);
  });

  it("includes the footer verbatim and suppresses all pings", () => {
    expect(texts(body)).toContain(CARD_FOOTER);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.flags & (1 << 15)).toBe(1 << 15);
  });

  it("has ack and manage buttons while active", () => {
    expect(buttons(body).map((b) => b.custom_id)).toEqual(["sb1:ack:7", "sb1:manage:7"]);
  });

  it("stopped card has no buttons and a stop line", () => {
    const stopped = buildCardBody({
      tracked: { ...tracked, stoppedAt: T0 + HOUR, stopReason: "manual", stoppedByUserId: "100" },
      rows,
    });
    expect(buttons(stopped)).toEqual([]);
    expect(texts(stopped).at(-1)).toMatch(/^-# Tracking ended · stopped by <@100> · <t:\d+:f>$/);
  });

  it("source-deleted card says so and drops the jump link", () => {
    const deleted = buildCardBody({
      tracked: { ...tracked, stoppedAt: T0 + HOUR, stopReason: "source_deleted" },
      rows,
    });
    const all = texts(deleted).join("\n");
    expect(all).toContain("Original message was deleted");
    expect(all).not.toContain("https://discord.com/channels/");
  });

  it("orphan card has no buttons", () => {
    const orphan = buildOrphanBody();
    expect(buttons(orphan)).toEqual([]);
    expect(texts(orphan)).toEqual(["-# This tracking is no longer active."]);
  });

  it("stays within 40 components with 25 targets", () => {
    const many: ProjectionRow[] = Array.from({ length: 25 }, (_, i) => ({
      userId: String(1000 + i),
      state: (["CONFIRMED", "INTERACTED", "LIKELY", "UNKNOWN"] as const)[i % 4] ?? "UNKNOWN",
      basis: i % 4 === 3 ? null : { kind: "EXPLICIT_ACK", occurredAt: T0 },
    }));
    expect(countComponents(buildCardBody({ tracked, rows: many }).components)).toBeLessThanOrEqual(
      40,
    );
  });

  it("hash is deterministic and changes with content", () => {
    const a = cardRenderer.render({ tracked, rows });
    const b = cardRenderer.render({ tracked, rows });
    const c = cardRenderer.render({ tracked, rows: rows.slice(1) });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it("uses full date-time for evidence more than 24h after tracking start", () => {
    const late = buildCardBody({
      tracked,
      rows: [
        {
          userId: "12",
          state: "INTERACTED",
          basis: { kind: "DIRECT_REPLY", occurredAt: T0 + 25 * HOUR },
        },
      ],
    });
    expect(texts(late).join("\n")).toMatch(/<@12> · replied · <t:\d+:f>/);
  });
});

describe("M9 stop lines (spec §12.5)", () => {
  it("renders the three new stop reasons", async () => {
    const { stopLine } = await import("../../src/discord/render/text.ts");
    expect(stopLine("no_eligible_targets", null, "<t:1:f>")).toBe(
      "-# Tracking ended · no eligible targets remain · <t:1:f>",
    );
    expect(stopLine("target_limit_exceeded", null, "<t:1:f>", { limit: 100 })).toBe(
      "-# Tracking ended · too many eligible members (limit 100) · <t:1:f>",
    );
    expect(stopLine("feature_disabled", null, "<t:1:f>")).toBe(
      "-# Tracking ended · role-based auto-track was turned off · <t:1:f>",
    );
  });
});
