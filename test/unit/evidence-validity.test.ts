import { describe, expect, it } from "vitest";
import { isValidEvidence, weakLowerBound } from "../../src/domain/evidence-validity.ts";
import { CTX, HOUR, MIN, T0 } from "../helpers/domain.ts";

describe("isValidEvidence", () => {
  it("weak lower bound is max(createdAt, addedAt)", () => {
    expect(weakLowerBound(CTX, T0 - HOUR)).toBe(T0);
    expect(weakLowerBound(CTX, T0 + 30 * MIN)).toBe(T0 + 30 * MIN);
  });

  it("weak kinds require an occurrence time", () => {
    expect(isValidEvidence({ kind: "TYPING_AFTER", occurredAt: null }, T0, CTX)).toBe(false);
  });

  it("direct replies may predate addedAt", () => {
    expect(
      isValidEvidence({ kind: "DIRECT_REPLY", occurredAt: T0 + MIN }, T0 + 30 * MIN, CTX),
    ).toBe(true);
  });
});
