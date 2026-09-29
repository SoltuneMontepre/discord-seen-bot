import type { ValidityContext } from "../../src/domain/evidence-validity.ts";
import type { Ack, Evidence, EvidenceKind, Target } from "../../src/domain/types.ts";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Source posted at T0 - 10m; tracking starts at T0; weak window ends T0 + 2h. */
export const T0 = 1_780_000_000_000;
export const CTX: ValidityContext = {
  sourceCreatedAt: T0 - 10 * MIN,
  createdAt: T0,
  weakWindowEndsAt: T0 + 2 * HOUR,
};

export function target(userId: string, addedAt = T0): Target {
  return { userId, addedAt, addedByUserId: "900" };
}

export function ev(
  userId: string,
  kind: EvidenceKind,
  occurredAt: number | null,
  opts: { key?: string; observedAt?: number } = {},
): Evidence {
  const defaultKey =
    kind === "DIRECT_REPLY" ? `r${occurredAt}` : kind === "DIRECT_REACTION" ? "👍|0" : "";
  return {
    trackedMessageId: 1,
    userId,
    kind,
    sourceKey: opts.key ?? defaultKey,
    occurredAt,
    observedAt: opts.observedAt ?? (occurredAt ?? T0) + 1,
  };
}

export function ack(userId: string, acknowledgedAt: number, revokedAt: number | null = null): Ack {
  return { userId, acknowledgedAt, revokedAt };
}
