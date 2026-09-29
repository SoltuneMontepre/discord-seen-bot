import { describe, expect, it } from "vitest";
import { eligibleTargets } from "../../src/domain/eligibility.ts";

const AUTHOR = "100";

describe("eligibleTargets", () => {
  it("removes bots, unverifiable users, the author and duplicates, preserving order", () => {
    const r = eligibleTargets(
      [
        { id: "3", bot: false },
        { id: "9", bot: true },
        { id: AUTHOR, bot: false },
        { id: "4", bot: undefined },
        { id: "3", bot: false },
        { id: "2", bot: false },
      ],
      AUTHOR,
      25,
    );
    expect(r.targets).toEqual(["3", "2"]);
    expect(r.dropped).toEqual([
      { id: "9", reason: "bot" },
      { id: AUTHOR, reason: "author" },
      { id: "4", reason: "unverifiable" },
      { id: "3", reason: "duplicate" },
    ]);
  });

  it("caps at maxTargets with an over_cap reason", () => {
    const candidates = Array.from({ length: 26 }, (_, i) => ({ id: String(1000 + i), bot: false }));
    const r = eligibleTargets(candidates, AUTHOR, 25);
    expect(r.targets).toHaveLength(25);
    expect(r.dropped).toEqual([{ id: "1025", reason: "over_cap" }]);
  });

  it("returns empty targets when nobody is eligible", () => {
    const r = eligibleTargets(
      [
        { id: "9", bot: true },
        { id: AUTHOR, bot: false },
      ],
      AUTHOR,
      25,
    );
    expect(r.targets).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["bot", "author"]);
  });
});
