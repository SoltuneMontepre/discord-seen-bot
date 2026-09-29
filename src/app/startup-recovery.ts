import type { Repository } from "../db/repository.ts";
import type { Logger } from "./ports.ts";

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
