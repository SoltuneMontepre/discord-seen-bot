import type { Repository } from "../db/repository.ts";
import type { Policy } from "../domain/policy.ts";
import type { CardRenderer, Clock, DiscordPort, Logger } from "./ports.ts";
import { projectView } from "./view.ts";

/** What the tracking service needs from the scheduler. */
export interface DirtySink {
  markDirty(trackedId: number): void;
  renderNow(trackedId: number): Promise<void>;
}

interface Entry {
  timer?: ReturnType<typeof setTimeout>;
  firstDirtyAt?: number;
  inFlight?: Promise<void>;
  dirtyAgain: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  forbiddenStep: number;
  transientStep: number;
}

const FORBIDDEN_BACKOFF_MS = [30_000, 120_000, 600_000];
const TRANSIENT_RETRY_MS = 30_000;
const TRANSIENT_MAX_RETRIES = 5;

/**
 * Debounces and serializes companion edits per tracked message.
 * - markDirty: trailing debounce with a max wait.
 * - Only one edit in flight per tracked message; a dirty mark during an edit yields one follow-up.
 * - Skips the PATCH when the rendered hash equals the last successful render.
 */
export class RenderScheduler implements DirtySink {
  private readonly entries = new Map<number, Entry>();
  private readonly repo: Repository;
  private readonly renderer: CardRenderer;
  private readonly port: DiscordPort;
  private readonly clock: Clock;
  private readonly policy: Policy;
  private readonly logger: Logger;
  private stopped = false;

  constructor(deps: {
    repo: Repository;
    renderer: CardRenderer;
    port: DiscordPort;
    clock: Clock;
    policy: Policy;
    logger: Logger;
  }) {
    this.repo = deps.repo;
    this.renderer = deps.renderer;
    this.port = deps.port;
    this.clock = deps.clock;
    this.policy = deps.policy;
    this.logger = deps.logger;
  }

  private entry(id: number): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { dirtyAgain: false, forbiddenStep: 0, transientStep: 0 };
      this.entries.set(id, e);
    }
    return e;
  }

  markDirty(id: number): void {
    if (this.stopped) return;
    const e = this.entry(id);
    if (e.inFlight) {
      e.dirtyAgain = true;
      return;
    }
    const now = this.clock.now();
    e.firstDirtyAt ??= now;
    if (e.timer) clearTimeout(e.timer);
    const waited = now - e.firstDirtyAt;
    const delay = Math.max(
      0,
      Math.min(this.policy.renderDebounceMs, this.policy.renderMaxWaitMs - waited),
    );
    e.timer = setTimeout(() => void this.flush(id), delay);
  }

  /** Render without waiting for the debounce (after any in-flight edit completes). */
  async renderNow(id: number): Promise<void> {
    const e = this.entry(id);
    if (e.inFlight) await e.inFlight;
    await this.flush(id);
  }

  /**
   * The card was already delivered via an interaction UPDATE_MESSAGE: record its hash and cancel any
   * pending debounced render so the same content is not PATCHed again.
   */
  async noteRendered(id: number, hash: string): Promise<void> {
    const e = this.entries.get(id);
    if (e?.timer) {
      clearTimeout(e.timer);
      e.timer = undefined;
      e.firstDirtyAt = undefined;
    }
    await this.repo.setRenderedHash(id, hash);
  }

  private flush(id: number): Promise<void> {
    const e = this.entry(id);
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = undefined;
    }
    e.firstDirtyAt = undefined;
    if (e.inFlight) {
      e.dirtyAgain = true;
      return e.inFlight;
    }
    const run = this.renderOnce(id, e)
      .catch((error: unknown) => this.logger.error({ trackedId: id, err: error }, "render failed"))
      .finally(() => {
        e.inFlight = undefined;
        if (e.dirtyAgain) {
          e.dirtyAgain = false;
          this.markDirty(id);
        } else if (!e.timer && !e.retryTimer) {
          this.entries.delete(id);
        }
      });
    e.inFlight = run;
    return run;
  }

  private scheduleRetry(id: number, e: Entry, delay: number): void {
    if (this.stopped) return;
    if (e.retryTimer) clearTimeout(e.retryTimer);
    e.retryTimer = setTimeout(() => {
      e.retryTimer = undefined;
      this.markDirty(id);
    }, delay);
  }

  private async renderOnce(id: number, e: Entry): Promise<void> {
    const view = await this.repo.loadView(id);
    if (!view) return;
    const t = view.tracked;
    if (t.statusMessageId === null) return;
    if (t.stopReason === "status_deleted" || t.stopReason === "channel_deleted") return;

    const card = this.renderer.render({ tracked: t, rows: projectView(view) });
    if (card.hash === t.renderedHash) return;

    const result = await this.port.editCompanion(t.channelId, t.statusMessageId, card.body);
    if (result.ok) {
      e.forbiddenStep = 0;
      e.transientStep = 0;
      await this.repo.setRenderedHash(id, card.hash);
      return;
    }
    const now = this.clock.now();
    switch (result.kind) {
      case "MessageMissing":
        this.logger.info({ trackedId: id }, "companion deleted; stopping tracking");
        await this.repo.stopTracking(id, "status_deleted", now);
        return;
      case "ChannelMissing":
        this.logger.info({ trackedId: id }, "channel deleted; stopping tracking");
        await this.repo.stopTracking(id, "channel_deleted", now);
        return;
      case "ArchivedThread":
        // Stays unrendered (hash unchanged); THREAD_UNARCHIVED marks it dirty again.
        this.logger.info({ trackedId: id, code: result.code }, "thread archived; render deferred");
        return;
      case "Forbidden": {
        const delay = FORBIDDEN_BACKOFF_MS[e.forbiddenStep];
        this.logger.warn({ trackedId: id, code: result.code, retryInMs: delay }, "edit forbidden");
        if (delay !== undefined) {
          e.forbiddenStep += 1;
          this.scheduleRetry(id, e, delay);
        }
        return;
      }
      case "Transient":
        this.logger.warn({ trackedId: id, code: result.code }, "transient edit failure");
        if (e.transientStep < TRANSIENT_MAX_RETRIES) {
          e.transientStep += 1;
          this.scheduleRetry(id, e, TRANSIENT_RETRY_MS);
        }
        return;
    }
  }

  /** Graceful shutdown: render everything pending now (bounded), then stop scheduling. */
  async flushAll(timeoutMs: number): Promise<void> {
    const pending = [...this.entries.entries()]
      .filter(([, e]) => e.timer || e.inFlight)
      .map(([id]) => this.flush(id));
    this.stopped = true;
    for (const e of this.entries.values()) if (e.retryTimer) clearTimeout(e.retryTimer);
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /** Test helper: resolves when nothing is scheduled or in flight. */
  hasPendingWork(): boolean {
    for (const e of this.entries.values()) if (e.timer || e.inFlight || e.retryTimer) return true;
    return false;
  }
}
