import type { EvidenceKind, UnixMs } from "./types.ts";

export interface ValidityContext {
  sourceCreatedAt: UnixMs;
  /** Tracking start. */
  createdAt: UnixMs;
  weakWindowEndsAt: UnixMs;
}

/**
 * Single source of truth for evidence validity, used at write time (data minimization) and in the
 * projection (defense in depth).
 *
 * - DIRECT_REPLY: valid for the whole lifetime, may predate target.addedAt; must not predate the source.
 * - DIRECT_REACTION: existence on the source is the fact; occurredAt must be null (Discord gives none).
 * - Weak kinds: max(createdAt, target.addedAt) <= occurredAt <= weakWindowEndsAt (inclusive).
 */
export function isValidEvidence(
  e: { kind: EvidenceKind; occurredAt: UnixMs | null },
  targetAddedAt: UnixMs,
  ctx: ValidityContext,
): boolean {
  switch (e.kind) {
    case "DIRECT_REPLY":
      return e.occurredAt !== null && e.occurredAt >= ctx.sourceCreatedAt;
    case "DIRECT_REACTION":
      return e.occurredAt === null;
    case "CHANNEL_MESSAGE_AFTER":
    case "TYPING_AFTER":
      return (
        e.occurredAt !== null &&
        e.occurredAt >= weakLowerBound(ctx, targetAddedAt) &&
        e.occurredAt <= ctx.weakWindowEndsAt
      );
  }
}

export function weakLowerBound(ctx: ValidityContext, targetAddedAt: UnixMs): UnixMs {
  return Math.max(ctx.createdAt, targetAddedAt);
}
