import { describe, expect, it } from "vitest";
import { project } from "../../src/domain/projection.ts";
import type { Ack, Evidence, Target } from "../../src/domain/types.ts";
import { ack, CTX, DAY, ev, HOUR, MIN, T0, target } from "../helpers/domain.ts";

function one(targets: Target[], evidence: Evidence[], acks: Ack[] = []) {
  const rows = project({ targets, evidence, acks, tracked: CTX });
  return rows.find((r) => r.userId === "1");
}

describe("project(): weak window and addedAt", () => {
  it.each([
    ["typing 1m after start", ev("1", "TYPING_AFTER", T0 + MIN), "LIKELY"],
    [
      "channel message at window end (inclusive)",
      ev("1", "CHANNEL_MESSAGE_AFTER", T0 + 2 * HOUR),
      "LIKELY",
    ],
    ["typing 1ms after window end", ev("1", "TYPING_AFTER", T0 + 2 * HOUR + 1), "UNKNOWN"],
    ["weak evidence before tracking start", ev("1", "CHANNEL_MESSAGE_AFTER", T0 - 1), "UNKNOWN"],
  ])("%s → %s", (_name, evidence, state) => {
    expect(one([target("1")], [evidence])?.state).toBe(state);
  });

  it("target added at +30m: weak evidence at +10m is ignored, at +40m counts", () => {
    const t = target("1", T0 + 30 * MIN);
    expect(one([t], [ev("1", "CHANNEL_MESSAGE_AFTER", T0 + 10 * MIN)])?.state).toBe("UNKNOWN");
    expect(one([t], [ev("1", "CHANNEL_MESSAGE_AFTER", T0 + 40 * MIN)])?.state).toBe("LIKELY");
  });
});

describe("project(): direct interactions", () => {
  it("reply at +5m counts for a target added at +30m", () => {
    const row = one([target("1", T0 + 30 * MIN)], [ev("1", "DIRECT_REPLY", T0 + 5 * MIN)]);
    expect(row).toEqual({
      userId: "1",
      state: "INTERACTED",
      basis: { kind: "DIRECT_REPLY", occurredAt: T0 + 5 * MIN },
    });
  });

  it("reply on day 6 still counts", () => {
    expect(one([target("1")], [ev("1", "DIRECT_REPLY", T0 + 6 * DAY)])?.state).toBe("INTERACTED");
  });

  it("reaction has a null occurrence time in its basis", () => {
    expect(one([target("1")], [ev("1", "DIRECT_REACTION", null)])).toEqual({
      userId: "1",
      state: "INTERACTED",
      basis: { kind: "DIRECT_REACTION", occurredAt: null },
    });
  });

  it("reaction with an occurrence time is invalid (never trusted)", () => {
    expect(one([target("1")], [ev("1", "DIRECT_REACTION", T0 + MIN)])?.state).toBe("UNKNOWN");
  });

  it("reply + reaction → basis is the reply (known time), even if the reaction was observed first", () => {
    const row = one(
      [target("1")],
      [ev("1", "DIRECT_REACTION", null, { observedAt: T0 }), ev("1", "DIRECT_REPLY", T0 + 9 * MIN)],
    );
    expect(row?.basis).toEqual({ kind: "DIRECT_REPLY", occurredAt: T0 + 9 * MIN });
  });

  it("reply before the source was posted is ignored", () => {
    expect(one([target("1")], [ev("1", "DIRECT_REPLY", CTX.sourceCreatedAt - 1)])?.state).toBe(
      "UNKNOWN",
    );
  });

  it("LIKELY + DIRECT_REPLY → INTERACTED", () => {
    const row = one(
      [target("1")],
      [ev("1", "TYPING_AFTER", T0 + MIN), ev("1", "DIRECT_REPLY", T0 + 2 * MIN)],
    );
    expect(row?.state).toBe("INTERACTED");
  });
});

describe("project(): reply deletion (evidence rows removed)", () => {
  const reply1 = ev("1", "DIRECT_REPLY", T0 + MIN, { key: "r1" });
  const reply2 = ev("1", "DIRECT_REPLY", T0 + 2 * MIN, { key: "r2" });
  const typing = ev("1", "TYPING_AFTER", T0 + 3 * MIN);

  it("one reply deleted → UNKNOWN", () => {
    expect(one([target("1")], [reply1])?.state).toBe("INTERACTED");
    expect(one([target("1")], [])?.state).toBe("UNKNOWN");
  });

  it("one reply deleted with weak evidence present → LIKELY", () => {
    expect(one([target("1")], [typing])?.state).toBe("LIKELY");
  });

  it("two replies, one deleted → still INTERACTED; basis moves to the remaining reply", () => {
    expect(one([target("1")], [reply1, reply2])?.basis?.occurredAt).toBe(T0 + MIN);
    const row = one([target("1")], [reply2]);
    expect(row?.state).toBe("INTERACTED");
    expect(row?.basis?.occurredAt).toBe(T0 + 2 * MIN);
  });
});

describe("project(): acknowledgements", () => {
  it("LIKELY + ack → CONFIRMED with ack time", () => {
    const row = one([target("1")], [ev("1", "TYPING_AFTER", T0 + MIN)], [ack("1", T0 + 5 * MIN)]);
    expect(row).toEqual({
      userId: "1",
      state: "CONFIRMED",
      basis: { kind: "EXPLICIT_ACK", occurredAt: T0 + 5 * MIN },
    });
  });

  it("CONFIRMED + later typing stays CONFIRMED", () => {
    const row = one([target("1")], [ev("1", "TYPING_AFTER", T0 + 9 * MIN)], [ack("1", T0 + MIN)]);
    expect(row?.state).toBe("CONFIRMED");
  });

  it("revoked ack + reply → INTERACTED", () => {
    const row = one(
      [target("1")],
      [ev("1", "DIRECT_REPLY", T0 + MIN)],
      [ack("1", T0 + 2 * MIN, T0 + 3 * MIN)],
    );
    expect(row?.state).toBe("INTERACTED");
  });

  it("revoked ack alone → UNKNOWN", () => {
    expect(one([target("1")], [], [ack("1", T0, T0 + MIN)])?.state).toBe("UNKNOWN");
  });
});

describe("project(): scoping and determinism", () => {
  it("ignores evidence and acks from non-targets", () => {
    const rows = project({
      targets: [target("1")],
      evidence: [ev("2", "DIRECT_REPLY", T0 + MIN)],
      acks: [ack("2", T0)],
      tracked: CTX,
    });
    expect(rows).toEqual([{ userId: "1", state: "UNKNOWN", basis: null }]);
  });

  it("orders by state, then by (addedAt, userId), independent of input order", () => {
    const targets = [target("5"), target("3"), target("4"), target("2", T0 + MIN)];
    const evidence = [ev("4", "TYPING_AFTER", T0 + MIN), ev("2", "DIRECT_REPLY", T0 + 2 * MIN)];
    const acks = [ack("5", T0)];
    const a = project({ targets, evidence, acks, tracked: CTX });
    const b = project({
      targets: [...targets].reverse(),
      evidence: [...evidence].reverse(),
      acks,
      tracked: CTX,
    });
    expect(a).toEqual(b);
    expect(a.map((r) => [r.userId, r.state])).toEqual([
      ["5", "CONFIRMED"],
      ["2", "INTERACTED"],
      ["4", "LIKELY"],
      ["3", "UNKNOWN"],
    ]);
  });
});
