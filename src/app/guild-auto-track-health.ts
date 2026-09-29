import type { Policy } from "../domain/policy.ts";
import type { Snowflake, UnixMs } from "../domain/types.ts";
import type { Clock, Logger } from "./ports.ts";

export type GuildHealthState =
  | "awaiting_guild"
  | "rebuilding"
  | "reconciling"
  | "failed"
  | "unavailable"
  | "healthy";

export interface GuildHealthDetail {
  reason?: string;
  code?: number;
  attempt?: number;
  nextRetryInMs?: number;
}

interface Entry {
  state: GuildHealthState;
  pausedSince: UnixMs | undefined;
  detail: GuildHealthDetail;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Runtime member-state health per guild (spec §9.1; never persisted). Anything but `healthy` is
 * paused; an unknown guild is `awaiting_guild`. Entering a pause starts a grace timer after which
 * `onPauseNoticeDue` fires once (spec §9.4).
 */
export class GuildAutoTrackHealth {
  private readonly entries = new Map<Snowflake, Entry>();
  private readonly deps: {
    clock: Clock;
    policy: Pick<Policy, "pauseNoticeGraceMs">;
    onPauseNoticeDue(guildId: Snowflake): void;
    logger: Logger;
  };

  constructor(deps: GuildAutoTrackHealth["deps"]) {
    this.deps = deps;
  }

  state(guildId: Snowflake): GuildHealthState {
    return this.entries.get(guildId)?.state ?? "awaiting_guild";
  }

  isPaused(guildId: Snowflake): boolean {
    return this.state(guildId) !== "healthy";
  }

  pausedSince(guildId: Snowflake): UnixMs | undefined {
    return this.entries.get(guildId)?.pausedSince;
  }

  detail(guildId: Snowflake): GuildHealthDetail {
    return this.entries.get(guildId)?.detail ?? {};
  }

  set(guildId: Snowflake, state: GuildHealthState, detail: GuildHealthDetail = {}): void {
    const e = this.entries.get(guildId);
    const wasPaused = e !== undefined && e.state !== "healthy";
    const entry: Entry = e ?? {
      state,
      pausedSince: undefined,
      detail: {},
      graceTimer: undefined,
    };
    const from = e?.state;
    entry.state = state;
    entry.detail = detail;
    if (state === "healthy") {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = undefined;
      entry.pausedSince = undefined;
    } else if (!wasPaused) {
      entry.pausedSince = this.deps.clock.now();
      entry.graceTimer = setTimeout(() => {
        entry.graceTimer = undefined;
        if (this.entries.get(guildId) === entry && entry.state !== "healthy") {
          this.deps.onPauseNoticeDue(guildId);
        }
      }, this.deps.policy.pauseNoticeGraceMs);
    }
    this.entries.set(guildId, entry);
    if (from !== state) this.deps.logger.debug({ guildId, from, to: state }, "auto-track health");
  }

  /** Fresh READY: member state must be rebuilt for every guild. */
  resetAll(): void {
    for (const guildId of [...this.entries.keys()]) this.set(guildId, "awaiting_guild");
  }

  forget(guildId: Snowflake): void {
    clearTimeout(this.entries.get(guildId)?.graceTimer);
    this.entries.delete(guildId);
  }

  dispose(): void {
    for (const e of this.entries.values()) clearTimeout(e.graceTimer);
    this.entries.clear();
  }
}
