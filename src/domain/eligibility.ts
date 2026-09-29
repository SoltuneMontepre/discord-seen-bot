import type { Snowflake } from "./types.ts";

export interface TargetCandidate {
  id: Snowflake;
  /** undefined = cannot be verified (e.g. picker value without resolved user data). */
  bot: boolean | undefined;
}

export type DropReason = "bot" | "author" | "unverifiable" | "duplicate" | "over_cap";

export interface EligibilityResult {
  targets: Snowflake[];
  dropped: { id: Snowflake; reason: DropReason }[];
}

/**
 * Shared target rules for mentions, the start picker, and Manage → Edit targets.
 * Callers must additionally require `targets.length >= 1`.
 */
export function eligibleTargets(
  candidates: readonly TargetCandidate[],
  sourceAuthorId: Snowflake,
  maxTargets: number,
): EligibilityResult {
  const targets: Snowflake[] = [];
  const dropped: EligibilityResult["dropped"] = [];
  const seen = new Set<Snowflake>();

  for (const c of candidates) {
    if (seen.has(c.id)) {
      dropped.push({ id: c.id, reason: "duplicate" });
      continue;
    }
    seen.add(c.id);
    if (c.bot === undefined) dropped.push({ id: c.id, reason: "unverifiable" });
    else if (c.bot) dropped.push({ id: c.id, reason: "bot" });
    else if (c.id === sourceAuthorId) dropped.push({ id: c.id, reason: "author" });
    else if (targets.length >= maxTargets) dropped.push({ id: c.id, reason: "over_cap" });
    else targets.push(c.id);
  }
  return { targets, dropped };
}
