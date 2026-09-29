export type Snowflake = string;
/** Milliseconds since the Unix epoch. */
export type UnixMs = number;

export const EVIDENCE_KINDS = [
  "DIRECT_REPLY",
  "DIRECT_REACTION",
  "CHANNEL_MESSAGE_AFTER",
  "TYPING_AFTER",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const DIRECT_KINDS: ReadonlySet<EvidenceKind> = new Set(["DIRECT_REPLY", "DIRECT_REACTION"]);
export const WEAK_KINDS: ReadonlySet<EvidenceKind> = new Set([
  "CHANNEL_MESSAGE_AFTER",
  "TYPING_AFTER",
]);

export type AckState = "CONFIRMED" | "INTERACTED" | "LIKELY" | "UNKNOWN";
export const STATE_ORDER: readonly AckState[] = ["CONFIRMED", "INTERACTED", "LIKELY", "UNKNOWN"];

export const STOP_REASONS = [
  "manual",
  "expired",
  "source_deleted",
  "status_deleted",
  "channel_deleted",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface TrackedMessage {
  id: number;
  guildId: Snowflake;
  /** Thread id when tracked inside a thread or forum post. */
  channelId: Snowflake;
  parentChannelId: Snowflake | null;
  sourceMessageId: Snowflake;
  sourceAuthorId: Snowflake;
  sourceCreatedAt: UnixMs;
  /** NULL only while a start is in flight. */
  statusMessageId: Snowflake | null;
  creatorUserId: Snowflake;
  /** Tracking start. */
  createdAt: UnixMs;
  weakWindowEndsAt: UnixMs;
  expiresAt: UnixMs;
  initialBackfillAt: UnixMs | null;
  stoppedAt: UnixMs | null;
  stopReason: StopReason | null;
  stoppedByUserId: Snowflake | null;
  renderedHash: string | null;
}

export interface Target {
  userId: Snowflake;
  addedByUserId: Snowflake;
  /** Lower bound for this target's weak evidence. */
  addedAt: UnixMs;
}

export interface Evidence {
  trackedMessageId: number;
  userId: Snowflake;
  kind: EvidenceKind;
  /** DIRECT_REPLY: reply message id · DIRECT_REACTION: "<emoji>|<type>" · weak kinds: "". */
  sourceKey: string;
  /** Discord-authoritative event time. Always null for DIRECT_REACTION (Discord gives none). */
  occurredAt: UnixMs | null;
  /** When this bot recorded the evidence (gateway receipt or reconciliation). */
  observedAt: UnixMs;
}

export interface Ack {
  userId: Snowflake;
  acknowledgedAt: UnixMs;
  revokedAt: UnixMs | null;
}

export type BasisKind = EvidenceKind | "EXPLICIT_ACK";

export interface ProjectionRow {
  userId: Snowflake;
  state: AckState;
  basis: { kind: BasisKind; occurredAt: UnixMs | null } | null;
}
