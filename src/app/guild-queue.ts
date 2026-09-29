import { AsyncLocalStorage } from "node:async_hooks";
import type { Snowflake } from "../domain/types.ts";

/** A same-guild run/runKeyed from inside that guild's running task would deadlock. */
export class NestedGuildQueueError extends Error {
  constructor(guildId: Snowflake) {
    super(`nested guild queue call for guild ${guildId} from inside its own running task`);
    this.name = "NestedGuildQueueError";
  }
}

/** Ownership chain of the current async context. `active` turns false when the task ends. */
interface Frame {
  guildId: Snowflake;
  active: boolean;
  parent: Frame | undefined;
}

/**
 * Per-guild FIFO task queue (spec §10, D16). Tasks of one guild run one at a time; guilds run
 * concurrently. Detects same-guild re-entry (and cross-guild cycles) via AsyncLocalStorage and
 * throws NestedGuildQueueError instead of deadlocking. Timers or continuations that outlive
 * the task are not "inside" it.
 */
export class GuildQueue {
  private readonly tails = new Map<Snowflake, Promise<void>>();
  private readonly pendingKeyed = new Map<string, Promise<void>>();
  private readonly als = new AsyncLocalStorage<Frame>();

  run<T>(guildId: Snowflake, task: () => Promise<T>): Promise<T> {
    if (this.owns(guildId)) return Promise.reject(new NestedGuildQueueError(guildId));
    const parent = this.als.getStore();
    const prev = this.tails.get(guildId) ?? Promise.resolve();
    const result = prev.then(() => {
      const frame: Frame = { guildId, active: true, parent };
      return this.als.run(frame, async () => {
        try {
          return await task();
        } finally {
          frame.active = false;
        }
      });
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(guildId, tail);
    void tail.then(() => {
      if (this.tails.get(guildId) === tail) this.tails.delete(guildId);
    });
    return result;
  }

  /**
   * Lossless keyed scheduling:
   * - not pending → enqueue
   * - pending (not started) → merge into the pending run (same promise)
   * - running → a new run is enqueued, so exactly ONE trailing rerun follows it
   * The task must recompute from source of truth; a rerun never needs the dirtying call's arguments.
   */
  runKeyed(guildId: Snowflake, key: string, task: () => Promise<void>): Promise<void> {
    if (this.owns(guildId)) return Promise.reject(new NestedGuildQueueError(guildId));
    const k = `${guildId}\u0000${key}`;
    const pending = this.pendingKeyed.get(k);
    if (pending) return pending;
    const p: Promise<void> = this.run(guildId, () => {
      if (this.pendingKeyed.get(k) === p) this.pendingKeyed.delete(k);
      return task();
    });
    this.pendingKeyed.set(k, p);
    return p;
  }

  /** For …InQueue methods: throws unless the current async context owns the guild's slot. */
  assertInQueue(guildId: Snowflake): void {
    if (!this.owns(guildId)) {
      throw new Error(`not inside the guild queue task for guild ${guildId}`);
    }
  }

  private owns(guildId: Snowflake): boolean {
    for (let f = this.als.getStore(); f; f = f.parent) {
      if (f.active && f.guildId === guildId) return true;
    }
    return false;
  }
}
