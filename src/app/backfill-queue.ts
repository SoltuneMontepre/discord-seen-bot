import pLimit from "p-limit";
import type { Snowflake } from "../domain/types.ts";
import type { Logger } from "./ports.ts";

/**
 * Bounded, coalescing hand-off for target backfills (spec §10: backfill limit 2). Users queued for
 * a tracking whose backfill has not started yet are merged into that pending run.
 */
export class BackfillQueue {
  private readonly deps: {
    backfill(trackedId: number, userIds: readonly Snowflake[]): Promise<void>;
    concurrency: number;
    logger: Logger;
  };
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly pending = new Map<number, Set<Snowflake>>();
  private readonly running = new Set<Promise<void>>();
  private disposed = false;

  constructor(deps: BackfillQueue["deps"]) {
    this.deps = deps;
    this.limit = pLimit(deps.concurrency);
  }

  enqueue(trackedId: number, userIds: readonly Snowflake[]): void {
    if (this.disposed || userIds.length === 0) return;
    const merged = this.pending.get(trackedId);
    if (merged) {
      for (const u of userIds) merged.add(u);
      return;
    }
    this.pending.set(trackedId, new Set(userIds));
    const p = this.limit(async () => {
      const users = this.pending.get(trackedId) ?? new Set<Snowflake>();
      this.pending.delete(trackedId);
      if (this.disposed) return;
      try {
        await this.deps.backfill(trackedId, [...users]);
      } catch (err) {
        this.deps.logger.warn({ trackedId, err }, "target backfill failed");
      }
    });
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
  }

  /** Resolves when every queued backfill has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  dispose(): void {
    this.disposed = true;
    this.limit.clearQueue();
    this.pending.clear();
  }
}
