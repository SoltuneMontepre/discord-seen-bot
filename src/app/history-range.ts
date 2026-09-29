import type { DiscordPort, HistoryMessage } from "./ports.ts";

export type WalkFailureClass = "Transient" | "Permanent" | "NoProgress";

/** A failed walk. `cursor` is the last good exclusive upper bound, so a retry can resume there. */
export class HistoryWalkError extends Error {
  readonly failure: WalkFailureClass;
  readonly cursor: bigint;
  readonly code: number | undefined;

  constructor(failure: WalkFailureClass, cursor: bigint, code?: number, cause?: unknown) {
    super(`history walk failed: ${failure}${code === undefined ? "" : ` (${code})`}`, { cause });
    this.name = "HistoryWalkError";
    this.failure = failure;
    this.cursor = cursor;
    this.code = code;
  }
}

export interface WalkHistoryRangeOptions {
  port: Pick<DiscordPort, "getMessagesBefore">;
  channelId: string;
  lowerExclusive: bigint;
  upperExclusive: bigint;
  maxPages?: number;
  signal?: AbortSignal;
  pageSize?: number;
  /** Receives only messages strictly inside (lower, upper). Must be idempotent. */
  onMessages: (messages: HistoryMessage[]) => Promise<void>;
}

export interface WalkResult {
  outcome: "complete" | "truncated";
  pages: number;
  /** Exclusive upper bound where the walk stopped (== lower bound region when complete). */
  cursor: bigint;
}

/**
 * Walks message history backwards (newest → oldest) with `before` cursors between explicit
 * snowflake bounds. Discord documents Get Channel Messages as returning newest → oldest, so a
 * repeated `after=` walk cannot exhaustively cover a large interval. Correctness depends only on
 * explicitly computed min ids — never on the order of the response array.
 */
export async function walkHistoryRange(o: WalkHistoryRangeOptions): Promise<WalkResult> {
  const pageSize = o.pageSize ?? 100;
  let cursor = o.upperExclusive;
  let pages = 0;
  if (o.lowerExclusive >= o.upperExclusive) return { outcome: "complete", pages, cursor };

  for (;;) {
    o.signal?.throwIfAborted();
    if (o.maxPages !== undefined && pages >= o.maxPages) {
      return { outcome: "truncated", pages, cursor };
    }
    const page = await o.port.getMessagesBefore(o.channelId, cursor, pageSize);
    pages += 1;
    if (!page.ok) {
      const failure = page.class === "Transient" ? "Transient" : "Permanent";
      throw new HistoryWalkError(failure, cursor, page.code, page.error);
    }
    if (page.value.length === 0) return { outcome: "complete", pages, cursor };

    let oldest: bigint | null = null;
    const inRange: HistoryMessage[] = [];
    for (const m of page.value) {
      const id = BigInt(m.id);
      if (oldest === null || id < oldest) oldest = id;
      if (id > o.lowerExclusive && id < o.upperExclusive) inRange.push(m);
    }
    if (inRange.length > 0) await o.onMessages(inRange);

    if (oldest === null || oldest <= o.lowerExclusive)
      return { outcome: "complete", pages, cursor };
    if (oldest >= cursor) throw new HistoryWalkError("NoProgress", cursor);
    cursor = oldest;
  }
}
