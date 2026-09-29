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
  // ---- M9 auto-tracking
  /** D8: maximum resolved auto targets (after union, dedupe, author and bot exclusion). */
  autoTrackMaxTargets: number;
  /** Delay before paused role-dependent cards are proactively refreshed with the pause notice. */
  pauseNoticeGraceMs: number;
  /** Global cap on concurrent status-card edits. */
  renderEditConcurrency: number;
  /** Member-state rebuild retry backoff; after the list is exhausted, retry every memberRebuildSteadyMs. */
  memberRebuildBackoffMs: readonly number[];
  memberRebuildSteadyMs: number;
  /** Retry delay for an index-only recovery reconcile after a DB failure. */
  reconcileRetryMs: number;
  /** Minimum interval between "over limit" warnings per channel. */
  overLimitLogIntervalMs: number;
  backfillConcurrency: number;
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
  autoTrackMaxTargets: 100,
  pauseNoticeGraceMs: MINUTE,
  renderEditConcurrency: 2,
  memberRebuildBackoffMs: [MINUTE, 5 * MINUTE, 15 * MINUTE],
  memberRebuildSteadyMs: 15 * MINUTE,
  reconcileRetryMs: MINUTE,
  overLimitLogIntervalMs: 10 * MINUTE,
  backfillConcurrency: 2,
});
