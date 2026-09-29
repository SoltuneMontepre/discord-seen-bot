import pLimit from "p-limit";
import type { ReplyCursor, Repository } from "../db/repository.ts";
import type { Policy } from "../domain/policy.ts";
import { reactionKey } from "../domain/signals.ts";
import { maxBigInt, snowflakeFromTime } from "../domain/snowflake.ts";
import type { Snowflake, TrackedMessage, UnixMs } from "../domain/types.ts";
import type { GatewayHealth } from "./gateway-health.ts";
import { HistoryWalkError, walkHistoryRange } from "./history-range.ts";
import type { Clock, DiscordPort, HistoryMessage, Logger } from "./ports.ts";
import type { RenderScheduler } from "./render-scheduler.ts";
import type { SignalScope, TrackingService } from "./tracking-service.ts";

const GAP_RETRY_BACKOFF_MS = [60_000, 300_000, 900_000];
const GAP_RETRY_STEADY_MS = 900_000;
const SIGNAL_FAILURE_RESCAN_DELAY_MS = 60_000;
const REACTION_PASS_RETRY_DELAY_MS = 60_000;

export type ReactionPassResult = "ok" | "source_deleted" | "failed" | "inactive";

interface PendingChannel {
  lower: bigint;
  cursor: bigint;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface GapRun {
  gen: number;
  controller: AbortController;
  pending: Map<Snowflake, PendingChannel>;
}

/**
 * Restart safety and backfill. Never on the interaction latency path.
 * - Gap scan (message-derived evidence) is bounded by the gateway-health watermark.
 * - Reactions, reply deletions and source lifecycle are verified independently of the watermark.
 */
export class Reconciler {
  private readonly repo: Repository;
  private readonly port: DiscordPort;
  private readonly service: TrackingService;
  private readonly scheduler: RenderScheduler;
  private readonly health: GatewayHealth;
  private readonly clock: Clock;
  private readonly policy: Policy;
  private readonly logger: Logger;

  private gapGen = 0;
  private gap: GapRun | null = null;
  private sessionController: AbortController | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(deps: {
    repo: Repository;
    port: DiscordPort;
    service: TrackingService;
    scheduler: RenderScheduler;
    health: GatewayHealth;
    clock: Clock;
    policy: Policy;
    logger: Logger;
  }) {
    this.repo = deps.repo;
    this.port = deps.port;
    this.service = deps.service;
    this.scheduler = deps.scheduler;
    this.health = deps.health;
    this.clock = deps.clock;
    this.policy = deps.policy;
    this.logger = deps.logger;
  }

  private later(fn: () => void, delay: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  // ------------------------------------------------------------------ fresh session

  /**
   * Fresh READY sequence: gap scan → reaction passes (source deletion first) → pending initial
   * backfills → reply verification → mark all active dirty. Called after health.onReady().
   */
  async onFreshSession(readyAt: UnixMs): Promise<void> {
    this.sessionController?.abort();
    const session = new AbortController();
    this.sessionController = session;
    const W = await this.health.readWatermark();
    this.logger.info({ watermark: W, readyAt }, "fresh gateway session: reconciling");

    await this.startGapRecovery(W, readyAt).catch((err: unknown) => {
      if (!session.signal.aborted) this.logger.error({ err }, "gap recovery failed");
    });
    const steps: [string, () => Promise<unknown>][] = [
      ["reaction passes", () => this.reactionPassAll(session.signal)],
      ["initial backfills", () => this.pendingInitialBackfills(session.signal)],
      ["reply verification", () => this.verifyReplyEvidence(session.signal)],
    ];
    for (const [step, run] of steps) {
      if (session.signal.aborted) return;
      try {
        await run();
      } catch (err) {
        if (session.signal.aborted) return;
        this.logger.error({ step, err }, "reconciliation step failed");
      }
    }
    for (const t of await this.repo.listActive()) this.scheduler.markDirty(t.id);
  }

  // ------------------------------------------------------------------ gap recovery

  /** A message-derived write failed: freeze W and rescan from it shortly. */
  requestGapRecovery(): void {
    this.health.markGapRecoveryNeeded();
    const gen = this.supersedeGap();
    this.later(() => {
      if (gen !== this.gapGen) return;
      void this.health
        .readWatermark()
        .then((W) => this.runGap(gen, W, this.clock.now()))
        .catch((err: unknown) => this.logger.error({ err }, "gap rescan failed"));
    }, SIGNAL_FAILURE_RESCAN_DELAY_MS);
  }

  private supersedeGap(): number {
    if (this.gap) {
      this.gap.controller.abort();
      for (const p of this.gap.pending.values()) if (p.timer) clearTimeout(p.timer);
    }
    this.gap = null;
    this.gapGen += 1;
    return this.gapGen;
  }

  private startGapRecovery(W: UnixMs | null, readyAt: UnixMs): Promise<void> {
    const gen = this.supersedeGap();
    return this.runGap(gen, W, readyAt);
  }

  private async runGap(gen: number, W: UnixMs | null, upperAt: UnixMs): Promise<void> {
    const run: GapRun = { gen, controller: new AbortController(), pending: new Map() };
    this.gap = run;
    const upper = snowflakeFromTime(upperAt + this.policy.snapshotUpperOverlapMs);
    const timeLower = W === null ? null : snowflakeFromTime(W - this.policy.gapLowerOverlapMs);

    for (const [channelId, oldestSource] of await this.activeChannels()) {
      run.controller.signal.throwIfAborted();
      const lower = timeLower === null ? oldestSource : maxBigInt(oldestSource, timeLower);
      await this.scanGapChannel(run, channelId, lower, upper, 0);
    }
    this.maybeCompleteGap(run);
  }

  /** Channels with active tracking → oldest active source id (numeric, not lexical). */
  private async activeChannels(): Promise<Map<Snowflake, bigint>> {
    const map = new Map<Snowflake, bigint>();
    for (const t of await this.repo.listActive()) {
      if (t.statusMessageId === null) continue;
      const id = BigInt(t.sourceMessageId);
      const cur = map.get(t.channelId);
      if (cur === undefined || id < cur) map.set(t.channelId, id);
    }
    return map;
  }

  private async scanGapChannel(
    run: GapRun,
    channelId: Snowflake,
    lower: bigint,
    upper: bigint,
    attempt: number,
  ): Promise<void> {
    try {
      const r = await walkHistoryRange({
        port: this.port,
        channelId,
        lowerExclusive: lower,
        upperExclusive: upper,
        signal: run.controller.signal,
        onMessages: (msgs) => this.applyHistory(msgs, { propagateErrors: true }),
      });
      run.pending.delete(channelId);
      this.logger.debug({ channelId, pages: r.pages }, "gap scan channel complete");
    } catch (err) {
      if (run.controller.signal.aborted) throw err;
      const failure = err instanceof HistoryWalkError ? err.failure : "Transient";
      const cursor = err instanceof HistoryWalkError ? err.cursor : upper;
      if (failure === "Transient") {
        const delay = GAP_RETRY_BACKOFF_MS[attempt] ?? GAP_RETRY_STEADY_MS;
        this.logger.warn(
          { channelId, attempt, retryInMs: delay, err },
          "gap scan transient failure",
        );
        const pending: PendingChannel = { lower, cursor, attempt: attempt + 1 };
        pending.timer = this.later(() => void this.retryGapChannel(run, channelId), delay);
        run.pending.set(channelId, pending);
      } else {
        this.logger.error({ channelId, failure, err }, "gap scan channel unrecoverable");
        run.pending.delete(channelId);
      }
    }
  }

  private async retryGapChannel(run: GapRun, channelId: Snowflake): Promise<void> {
    const p = run.pending.get(channelId);
    if (!p || run.gen !== this.gapGen || run.controller.signal.aborted) return;
    try {
      if ((await this.repo.listActiveInChannel(channelId)).length === 0) {
        run.pending.delete(channelId);
      } else {
        await this.scanGapChannel(run, channelId, p.lower, p.cursor, p.attempt);
      }
      this.maybeCompleteGap(run);
    } catch (err) {
      if (!run.controller.signal.aborted) this.logger.error({ channelId, err }, "gap retry failed");
    }
  }

  private maybeCompleteGap(run: GapRun): void {
    if (run.pending.size === 0 && run.gen === this.gapGen && !run.controller.signal.aborted) {
      this.health.gapRecoveryCompleted();
      this.logger.info({ gen: run.gen }, "gap recovery complete; watermark may advance");
    }
  }

  private async applyHistory(msgs: HistoryMessage[], scope: SignalScope): Promise<void> {
    for (const m of msgs) for (const s of m.signals) await this.service.recordSignal(s, scope);
  }

  // ------------------------------------------------------------------ backfills (capped)

  /** Pre-existing replies/reactions after a successful start. Upper bound is stable across retries. */
  async initialBackfill(trackedId: number, signal?: AbortSignal): Promise<void> {
    const t = await this.repo.getTracked(trackedId);
    if (!t || t.stoppedAt !== null || t.statusMessageId === null) return;
    try {
      await this.backfillRange(t, t.createdAt, { onlyTrackedId: t.id }, signal);
      const r = await this.reactionPass(t);
      if (r === "failed") throw new Error("reaction pass failed");
      await this.repo.setInitialBackfillAt(t.id, this.clock.now());
    } catch (err) {
      if (signal?.aborted) return;
      this.logger.warn({ trackedId, err }, "initial backfill failed; will retry on next READY");
    }
  }

  /** Replies/reactions of newly added targets, which may predate their addedAt. */
  async backfillTargets(trackedId: number, userIds: readonly Snowflake[]): Promise<void> {
    if (userIds.length === 0) return;
    const t = await this.repo.getTracked(trackedId);
    if (!t || t.stoppedAt !== null) return;
    try {
      const targets = await this.repo.listTargets(trackedId);
      const wanted = new Set(userIds);
      const addedAt = Math.max(
        t.createdAt,
        ...targets.filter((x) => wanted.has(x.userId)).map((x) => x.addedAt),
      );
      await this.backfillRange(t, addedAt, { onlyTrackedId: t.id, onlyUserIds: wanted });
      await this.reactionPass(t);
    } catch (err) {
      this.logger.warn({ trackedId, err }, "target backfill failed");
    }
  }

  private async backfillRange(
    t: TrackedMessage,
    snapshotAt: UnixMs,
    scope: SignalScope,
    signal?: AbortSignal,
  ): Promise<void> {
    const r = await walkHistoryRange({
      port: this.port,
      channelId: t.channelId,
      lowerExclusive: BigInt(t.sourceMessageId),
      upperExclusive: snowflakeFromTime(snapshotAt + this.policy.snapshotUpperOverlapMs),
      maxPages: this.policy.backfillMaxPages,
      ...(signal ? { signal } : {}),
      onMessages: (msgs) => this.applyHistory(msgs, { ...scope, propagateErrors: true }),
    });
    if (r.outcome === "truncated") {
      this.logger.warn(
        { trackedId: t.id, pages: r.pages },
        "backfill truncated: replies in the oldest part of the interval (nearest the source) may be missed",
      );
    }
  }

  private async pendingInitialBackfills(signal: AbortSignal): Promise<void> {
    for (const t of await this.repo.listPendingInitialBackfill()) {
      signal.throwIfAborted();
      await this.initialBackfill(t.id, signal);
    }
  }

  // ------------------------------------------------------------------ reactions & source lifecycle

  private async reactionPassAll(signal: AbortSignal): Promise<void> {
    for (const t of await this.repo.listActive()) {
      signal.throwIfAborted();
      if (t.statusMessageId === null) continue;
      // Transient failures get a 60 s retry in addition to the next fresh READY.
      if ((await this.reactionPass(t)) === "failed") this.scheduleReactionPass(t.sourceMessageId);
    }
  }

  scheduleReactionPass(sourceMessageId: Snowflake): void {
    this.later(() => {
      void this.repo
        .findActiveBySource(sourceMessageId)
        .then((t) => (t ? this.reactionPass(t) : undefined))
        .catch((err: unknown) => this.logger.error({ err }, "scheduled reaction pass failed"));
    }, REACTION_PASS_RETRY_DELAY_MS);
  }

  /**
   * Reconciles DIRECT_REACTION rows with the source's current reactions. The source lookup doubles
   * as offline source-deletion detection: 10008 → stop('source_deleted') and freeze the card.
   * Stale rows are deleted only after a complete, successful listing.
   */
  async reactionPass(t: TrackedMessage): Promise<ReactionPassResult> {
    if (t.stoppedAt !== null) return "inactive";
    const source = await this.port.getMessage(t.channelId, t.sourceMessageId);
    if (!source.ok) {
      if (source.class === "NotFound") {
        this.logger.info({ trackedId: t.id }, "source deleted while offline");
        await this.service.stopAndRender(t.id, "source_deleted");
        return "source_deleted";
      }
      this.logger.warn(
        { trackedId: t.id, code: source.code },
        "reaction pass: source lookup failed",
      );
      return "failed";
    }

    const targets = new Set((await this.repo.listTargets(t.id)).map((x) => x.userId));
    const present = new Map<string, { userId: Snowflake; key: string }>();
    for (const r of source.value.reactions) {
      for (const type of [0, 1] as const) {
        if ((type === 0 ? r.normal : r.burst) <= 0) continue;
        let after: Snowflake | undefined;
        for (;;) {
          const page = await this.port.getReactionUsers(
            t.channelId,
            t.sourceMessageId,
            r.apiEmoji,
            type,
            after,
            100,
          );
          if (!page.ok) {
            this.logger.warn({ trackedId: t.id, code: page.code }, "reaction listing failed");
            return "failed";
          }
          for (const u of page.value) {
            if (!u.bot && targets.has(u.id)) {
              const key = reactionKey(r.emojiKey, type);
              present.set(`${u.id}\u0000${key}`, { userId: u.id, key });
            }
          }
          const last = page.value.at(-1);
          if (page.value.length < 100 || !last) break;
          after = last.id;
        }
      }
    }

    let changed = false;
    const now = this.clock.now();
    const stored = (await this.repo.listEvidence(t.id)).filter((e) => e.kind === "DIRECT_REACTION");
    const storedKeys = new Set(stored.map((e) => `${e.userId}\u0000${e.sourceKey}`));
    for (const [k, v] of present) {
      if (storedKeys.has(k)) continue;
      const r = await this.repo.recordEvidence(
        {
          trackedMessageId: t.id,
          userId: v.userId,
          kind: "DIRECT_REACTION",
          sourceKey: v.key,
          occurredAt: null,
          observedAt: now,
        },
        () => true,
      );
      if (r === "changed") changed = true;
    }
    for (const e of stored) {
      if (present.has(`${e.userId}\u0000${e.sourceKey}`)) continue;
      if (await this.repo.deleteEvidence(t.id, e.userId, "DIRECT_REACTION", e.sourceKey))
        changed = true;
    }
    if (changed) this.scheduler.markDirty(t.id);
    return "ok";
  }

  // ------------------------------------------------------------------ reply verification

  /**
   * Exhaustive, paged verification that stored replies still exist (catches deletes the bot could
   * not see). Batches of N from SQLite, bounded concurrency, no total cap; one failure never aborts
   * the rest. Transient failures are retried on the next fresh READY.
   */
  async verifyReplyEvidence(signal?: AbortSignal): Promise<{ checked: number; removed: number }> {
    const limit = pLimit(this.policy.replyVerifyConcurrency);
    const batchSize = this.policy.replyVerifyBatchSize;
    let cursor: ReplyCursor | null = null;
    let checked = 0;
    let removed = 0;
    for (;;) {
      signal?.throwIfAborted();
      const batch = await this.repo.pageActiveReplies(cursor, batchSize);
      await Promise.all(
        batch.map((row) =>
          limit(async () => {
            checked += 1;
            try {
              const r = await this.port.getMessage(row.channelId, row.sourceKey);
              if (r.ok) return;
              if (r.class === "NotFound") {
                const deleted = await this.repo.deleteEvidence(
                  row.trackedMessageId,
                  row.userId,
                  "DIRECT_REPLY",
                  row.sourceKey,
                );
                if (deleted) {
                  removed += 1;
                  this.scheduler.markDirty(row.trackedMessageId);
                }
                return;
              }
              this.logger.warn(
                {
                  trackedId: row.trackedMessageId,
                  userId: row.userId,
                  replyId: row.sourceKey,
                  code: r.code,
                },
                "reply verification lookup failed; kept",
              );
            } catch (err) {
              this.logger.warn(
                { trackedId: row.trackedMessageId, replyId: row.sourceKey, err },
                "reply verification error; kept",
              );
            }
          }),
        ),
      );
      if (batch.length < batchSize) break;
      const last = batch[batch.length - 1];
      if (!last) break;
      cursor = {
        trackedMessageId: last.trackedMessageId,
        userId: last.userId,
        sourceKey: last.sourceKey,
      };
    }
    return { checked, removed };
  }

  /** Shutdown / tests: cancel all timers and running work. */
  dispose(): void {
    this.sessionController?.abort();
    this.supersedeGap();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
