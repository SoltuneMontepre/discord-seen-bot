/** Product policy. Values are approved product decisions; see the implementation plan. */
export interface Policy {
  /** Active tracking lifetime (decision 2). */
  trackingTtlMs: number;
  /** Weak-inference horizon after tracking start (decision 5). */
  weakWindowMs: number;
  /** Hard-delete delay after tracking stops (decision 3). */
  retentionMs: number;
  maxTargets: number;
  renderDebounceMs: number;
  renderMaxWaitMs: number;
  /** Safety overlap subtracted from the recovery watermark for gap scans. */
  gapLowerOverlapMs: number;
  /** Overlap past a snapshot boundary (readyAt / createdAt / addedAt); idempotent with live delivery. */
  snapshotUpperOverlapMs: number;
  watermarkTickMs: number;
  heartbeatAckStaleMs: number;
  sweepIntervalMs: number;
  backfillMaxPages: number;
  replyVerifyBatchSize: number;
  replyVerifyConcurrency: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  trackingTtlMs: 7 * DAY,
  weakWindowMs: 2 * HOUR,
  retentionMs: 30 * DAY,
  maxTargets: 25,
  renderDebounceMs: 3_000,
  renderMaxWaitMs: 10_000,
  gapLowerOverlapMs: 5 * MINUTE,
  snapshotUpperOverlapMs: MINUTE,
  watermarkTickMs: MINUTE,
  heartbeatAckStaleMs: 2 * MINUTE,
  sweepIntervalMs: 5 * MINUTE,
  backfillMaxPages: 10,
  replyVerifyBatchSize: 200,
  replyVerifyConcurrency: 5,
});
