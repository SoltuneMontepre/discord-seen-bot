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
  origin: "manual",
  channelType: null,
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

describe("M9 card rendering", () => {
  const PAUSE =
    "-# ⏸ Auto-track temporarily paused — member state is unavailable. Last known targets are shown.";
  const auto: TrackedMessage = { ...tracked, origin: "auto", channelType: 0 };
  const many = (n: number): ProjectionRow[] =>
    Array.from({ length: n }, (_, i) => ({
      userId: String(1000 + i),
      state: "UNKNOWN",
      basis: null,
    }));

  it("manual card is byte-identical to the pre-M9 renderer (stored hashes)", () => {
    const h = (t: TrackedMessage, r: ProjectionRow[]) =>
      cardRenderer.render({ tracked: t, rows: r }).hash;
    expect(h(tracked, rows)).toBe(
      "9dd778af382c26234270cadcd376f532e02b2e40ab254cf52daa513a7d66ca67",
    );
    expect(
      h({ ...tracked, stoppedAt: T0 + HOUR, stopReason: "manual", stoppedByUserId: "100" }, rows),
    ).toBe("ea0c66eca5a65e72b5917ad725bb203413a2674eb67e76a6167e667e8c6f6f96");
    expect(h(tracked, many(25))).toBe(
      "58b9fb3d8512b1a7c9b161923abfa24973e255be81e20180d0a8a58b3785e177",
    );
  });

  it("auto cards carry the Auto-tracked label", () => {
    const [head] = texts(buildCardBody({ tracked: auto, rows }));
    expect(head).toMatch(/^### 👀 Seen status\n-# Auto-tracked · \[Tracked message\]/);
    expect(texts(buildCardBody({ tracked, rows }))[0]).not.toMatch(/Auto-tracked/);
  });

  it("pause notice only when autoTrackPaused, and it changes the hash", () => {
    const off = cardRenderer.render({ tracked: auto, rows });
    const on = cardRenderer.render({ tracked: auto, rows, autoTrackPaused: true });
    expect(texts(off.body)).not.toContain(PAUSE);
    expect(texts(on.body)).toContain(PAUSE);
    expect(on.hash).not.toBe(off.hash);
    expect(countComponents(on.body.components)).toBeLessThanOrEqual(40);
  });

  it("overflow: 26 targets → 25 user lines + '+1 more', header counts 26", () => {
    const body = buildCardBody({ tracked: auto, rows: many(26) });
    const all = texts(body).join("\n");
    expect(all).toMatch(/0\/26 confirmed/);
    expect(all.match(/<@\d+>/g)).toHaveLength(25);
    expect(all).toContain("-# +1 more not shown (counts are complete)");
  });

  it("overflow spans states in order; 100 targets stay within component limits", () => {
    const mixed: ProjectionRow[] = [
      ...many(20).map((r) => ({
        ...r,
        state: "CONFIRMED" as const,
        basis: { kind: "EXPLICIT_ACK" as const, occurredAt: T0 },
      })),
      ...many(80).map((r, i) => ({ ...r, userId: String(5000 + i) })),
    ];
    const body = buildCardBody({ tracked: auto, rows: mixed });
    const all = texts(body).join("\n");
    expect(all.match(/<@\d+>/g)).toHaveLength(25);
    expect(all).toContain("-# +75 more not shown (counts are complete)");
    expect(all).toMatch(/20\/100 confirmed/);
    expect(countComponents(body.components)).toBeLessThanOrEqual(40);
    expect(all.length).toBeLessThan(4000);
  });

  it.each([
    ["no_eligible_targets", "Tracking ended · no eligible targets remain"],
    ["target_limit_exceeded", "Tracking ended · too many eligible members (limit 100)"],
    ["feature_disabled", "Tracking ended · role-based auto-track was turned off"],
  ] as const)("stop line %s, no buttons", (reason, line) => {
    const body = buildCardBody({
      tracked: { ...auto, stoppedAt: T0 + HOUR, stopReason: reason, stoppedByUserId: null },
      rows,
      maxTargets: 100,
    });
    expect(texts(body).some((t) => t.startsWith(`-# ${line} · <t:`))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/"custom_id"/);
  });

  it("never pings and never renders role mentions", () => {
    const body = buildCardBody({ tracked: auto, rows: many(30), autoTrackPaused: true });
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(texts(body).join("\n")).not.toContain("<@&");
  });
});
