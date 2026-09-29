import type { UnixMs } from "../domain/types.ts";
import type { Clock, Logger } from "./ports.ts";

export interface WatermarkStore {
  getWatermark(): Promise<UnixMs | null>;
  setWatermark(at: UnixMs): Promise<void>;
}

/**
 * Gateway health state machine and recovery watermark (`last_gateway_healthy_at`).
 *
 * Invariant (narrowed to what this bot can reconstruct): for every message created before the
 * watermark W in a channel with active tracking, the DIRECT_REPLY / CHANNEL_MESSAGE_AFTER evidence
 * it implies has been recorded — live, via RESUME replay, or by a completed gap scan. A process
 * that stays alive while the gateway is disconnected never advances W.
 *
 * Reactions, reply deletions and source/companion lifecycle are reconciled by state verification on
 * each fresh READY, independent of W. TYPING_AFTER is best-effort; W makes no claim about it.
 */
export class GatewayHealth {
  connection: "down" | "up" = "down";
  lastHeartbeatAckAt: UnixMs | null = null;
  gapRecoveryPending = false;

  private readonly clock: Clock;
  private readonly store: WatermarkStore;
  private readonly ackStaleMs: number;
  private readonly logger: Logger;

  constructor(clock: Clock, store: WatermarkStore, ackStaleMs: number, logger: Logger) {
    this.clock = clock;
    this.store = store;
    this.ackStaleMs = ackStaleMs;
    this.logger = logger;
  }

  /**
   * Fresh session. Synchronously marks recovery pending, which blocks watermark writes; the caller
   * then reads W (async) — it cannot change in between because ticks are blocked.
   */
  onReady(): { readyAt: UnixMs } {
    const now = this.clock.now();
    this.connection = "up";
    this.lastHeartbeatAckAt = now;
    this.gapRecoveryPending = true;
    return { readyAt: now };
  }

  /** Discord replayed missed events: healthy again, no reconciliation. */
  onResumed(): void {
    this.connection = "up";
    this.lastHeartbeatAckAt = this.clock.now();
  }

  /** Disconnect, session loss or zombie close. */
  onClosed(code: number): void {
    if (this.connection === "up") this.logger.warn({ code }, "gateway connection closed");
    this.connection = "down";
  }

  onHeartbeatAck(ackAt: UnixMs): void {
    this.lastHeartbeatAckAt = ackAt;
  }

  gapRecoveryCompleted(): void {
    this.gapRecoveryPending = false;
  }

  /** A message-derived signal failed to persist: treat like a gap until a rescan completes. */
  markGapRecoveryNeeded(): void {
    this.gapRecoveryPending = true;
  }

  canAdvance(now: UnixMs = this.clock.now()): boolean {
    return (
      this.connection === "up" &&
      !this.gapRecoveryPending &&
      this.lastHeartbeatAckAt !== null &&
      now - this.lastHeartbeatAckAt <= this.ackStaleMs
    );
  }

  /** Called every watermark tick and once on graceful shutdown. Returns whether W advanced. */
  async tick(): Promise<boolean> {
    const now = this.clock.now();
    if (!this.canAdvance(now)) return false;
    await this.store.setWatermark(now);
    return true;
  }

  readWatermark(): Promise<UnixMs | null> {
    return this.store.getWatermark();
  }
}
