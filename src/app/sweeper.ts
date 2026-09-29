import type { Repository } from "../db/repository.ts";
import type { Policy } from "../domain/policy.ts";
import type { Clock, Logger } from "./ports.ts";
import type { TrackingService } from "./tracking-service.ts";

/** Expiry (7 days) and retention purge (30 days after stop). Uses the injected clock. */
export class Sweeper {
  private readonly repo: Repository;
  private readonly service: TrackingService;
  private readonly clock: Clock;
  private readonly policy: Policy;
  private readonly logger: Logger;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: {
    repo: Repository;
    service: TrackingService;
    clock: Clock;
    policy: Policy;
    logger: Logger;
  }) {
    this.repo = deps.repo;
    this.service = deps.service;
    this.clock = deps.clock;
    this.policy = deps.policy;
    this.logger = deps.logger;
  }

  async runOnce(): Promise<{ expired: number; purged: number }> {
    const now = this.clock.now();
    const expired = await this.repo.listExpired(now);
    for (const t of expired) {
      await this.service.stopAndRender(t.id, "expired", null, t.expiresAt);
    }
    const purged = await this.repo.purgeStoppedBefore(now - this.policy.retentionMs);
    if (expired.length > 0 || purged > 0)
      this.logger.info({ expired: expired.length, purged }, "sweep complete");
    return { expired: expired.length, purged };
  }

  start(): void {
    this.timer = setInterval(() => {
      this.runOnce().catch((err: unknown) => this.logger.error({ err }, "sweep failed"));
    }, this.policy.sweepIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
