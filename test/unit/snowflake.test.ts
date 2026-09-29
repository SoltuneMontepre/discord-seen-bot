import { describe, expect, it } from "vitest";
import { compareSnowflakes, snowflakeFromTime, timestampOf } from "../../src/domain/snowflake.ts";

describe("snowflake", () => {
  it("extracts the timestamp from a known id", () => {
    // Discord docs example id 175928847299117063 → 2016-04-30T11:18:25.796Z
    expect(timestampOf("175928847299117063")).toBe(1462015105796);
  });

  it("snowflakeFromTime is the lower bound for ids created at that ms", () => {
    const ms = 1462015105796;
    const lower = snowflakeFromTime(ms);
    expect(timestampOf(lower.toString())).toBe(ms);
    expect(BigInt("175928847299117063") >= lower).toBe(true);
    expect(BigInt("175928847299117063") < snowflakeFromTime(ms + 1)).toBe(true);
  });

  it("clamps times before the Discord epoch to 0", () => {
    expect(snowflakeFromTime(0)).toBe(0n);
  });

  it("compares numerically, not lexically", () => {
    expect(compareSnowflakes("9", "10")).toBe(-1);
    expect(compareSnowflakes("10", "10")).toBe(0);
  });
});
