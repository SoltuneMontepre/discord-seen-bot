import type { Snowflake, UnixMs } from "./types.ts";

export const DISCORD_EPOCH = 1_420_070_400_000n;

export function toBigInt(id: Snowflake): bigint {
  return BigInt(id);
}

/** Creation time encoded in a snowflake. */
export function timestampOf(id: Snowflake): UnixMs {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** Smallest snowflake that could have been created at `ms` (clamped at 0). */
export function snowflakeFromTime(ms: UnixMs): bigint {
  const t = BigInt(Math.floor(ms)) - DISCORD_EPOCH;
  return t <= 0n ? 0n : t << 22n;
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function compareSnowflakes(a: Snowflake, b: Snowflake): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
