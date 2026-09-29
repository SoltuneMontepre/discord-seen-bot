import type { Repository } from "../db/repository.ts";
import type { UnixMs } from "../domain/types.ts";
import type { Logger } from "./ports.ts";
import { isRoleDependentWhenRolesOff } from "./role-dependence.ts";

/**
 * Must run before the gateway connects (i.e. before any interaction can be accepted). With a single
 * instance and nothing in flight, an active row without a companion can only come from a process
 * that died mid-start. A companion that was posted but whose id was never stored becomes an orphan
 * card; its first click replaces it with "no longer active" (see the ack handler).
 */
export async function deleteUnfinishedStarts(repo: Repository, logger: Logger): Promise<number> {
  const n = await repo.deleteUnfinishedStarts();
  if (n > 0) logger.warn({ count: n }, "deleted unfinished starts left by a previous crash");
  return n;
}

/**
 * D6 (spec §14.3): with ROLE_TARGETS_ENABLED=false, active auto trackings that depend on role state
 * (a stored role source, or targets no stored user source explains) stop with feature_disabled.
 * Rows are kept; explicit-only auto trackings and manual trackings continue. Idempotent. Runs after
 * migrations and deleteUnfinishedStarts, before the gateway is created. Returns the stopped ids.
 */
export async function stopRoleDependentAutoTrackingsWhenDisabled(
  repo: Repository,
  logger: Logger,
  at: UnixMs,
): Promise<number[]> {
  const stopped: number[] = [];
  for (const t of await repo.listActiveAuto({})) {
    const sources = await repo.listTrackingSources(t.id);
    const targets = (await repo.listTargets(t.id)).map((x) => x.userId);
    if (!isRoleDependentWhenRolesOff(sources, targets)) continue;
    if (await repo.stopAuto(t.id, "feature_disabled", at)) stopped.push(t.id);
  }
  if (stopped.length > 0) {
    logger.info(
      { count: stopped.length, trackedIds: stopped },
      "stopped role-dependent auto trackings (ROLE_TARGETS_ENABLED=false)",
    );
  }
  return stopped;
}
