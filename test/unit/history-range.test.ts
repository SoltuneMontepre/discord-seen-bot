import { describe, expect, it, vi } from "vitest";
import { HistoryWalkError, walkHistoryRange } from "../../src/app/history-range.ts";
import type { HistoryMessage } from "../../src/app/ports.ts";
import { T0 } from "../helpers/domain.ts";
import { FakeDiscord, snowflakeAt, transient } from "../helpers/fake-discord.ts";

const CH = "600";

/** ids at T0 + i ms: strictly increasing snowflakes. */
function seed(d: FakeDiscord, count: number, startMs = T0): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = snowflakeAt(startMs + i);
    d.addMessage(CH, id, "1");
    ids.push(id);
  }
  return ids;
}

async function collect(d: FakeDiscord, lower: bigint, upper: bigint, maxPages?: number) {
  const delivered: string[] = [];
  const result = await walkHistoryRange({
    port: d,
    channelId: CH,
    lowerExclusive: lower,
    upperExclusive: upper,
    ...(maxPages === undefined ? {} : { maxPages }),
    onMessages: async (msgs: HistoryMessage[]) => {
      delivered.push(...msgs.map((m) => m.id));
    },
  });
  return { delivered, result };
}

describe("walkHistoryRange", () => {
  for (const shuffle of [false, true]) {
    it(`regression: 357 messages, every in-range id exactly once (${shuffle ? "shuffled" : "newest→oldest"} pages)`, async () => {
      const d = new FakeDiscord();
      d.shufflePages = shuffle;
      const ids = seed(d, 357);
      // 20 at or below lower (index 19 == lower), 312 strictly inside, 25 at/above upper (index 332 == upper)
      const lower = BigInt(ids[19] as string);
      const upper = BigInt(ids[332] as string);
      const inside = ids.slice(20, 332);
      expect(inside).toHaveLength(312);

      const { delivered, result } = await collect(d, lower, upper);
      expect(result.outcome).toBe("complete");
      expect(new Set(delivered).size).toBe(delivered.length); // exactly once
      expect([...delivered].sort()).toEqual([...inside].sort());
      expect(delivered).toContain(inside[0]); // older part not skipped
      expect(delivered).not.toContain(ids[19]);
      expect(delivered).not.toContain(ids[332]);
      expect(d.count("getMessagesBefore")).toBeLessThanOrEqual(4); // 332 messages below upper
      // No call ever uses an `after` parameter; all cursors are `before` values ≤ upper.
      for (const c of d.calls) expect(c.args[1] as bigint).toBeLessThanOrEqual(upper);
    });
  }

  it("uncapped: 2,500 in-range messages across 25+ pages", async () => {
    const d = new FakeDiscord();
    const ids = seed(d, 2502);
    const { delivered, result } = await collect(
      d,
      BigInt(ids[0] as string),
      BigInt(ids[2501] as string),
    );
    expect(result.outcome).toBe("complete");
    expect(delivered).toHaveLength(2500);
    expect(result.pages).toBeGreaterThanOrEqual(25);
  });

  it("maxPages=10 delivers the newest 1,000 and reports truncation (oldest part is missed)", async () => {
    const d = new FakeDiscord();
    const ids = seed(d, 1502);
    const inside = ids.slice(1, 1501);
    const { delivered, result } = await collect(
      d,
      BigInt(ids[0] as string),
      BigInt(ids[1501] as string),
      10,
    );
    expect(result.outcome).toBe("truncated");
    expect(delivered).toHaveLength(1000);
    expect([...delivered].sort()).toEqual([...inside.slice(500)].sort());
    expect(delivered).not.toContain(inside[0]);
  });

  it("empty channel → complete after one call", async () => {
    const d = new FakeDiscord();
    const { result } = await collect(d, 0n, 10n ** 19n);
    expect(result).toMatchObject({ outcome: "complete", pages: 1 });
  });

  it("throws NoProgress instead of looping when the API repeats a page", async () => {
    const d = new FakeDiscord();
    const ids = seed(d, 5);
    d.historyHook = () => undefined;
    const port = {
      getMessagesBefore: vi.fn(async () => ({
        ok: true as const,
        value: [{ id: ids[4] as string, signals: [] }],
      })),
    };
    await expect(
      walkHistoryRange({
        port,
        channelId: CH,
        lowerExclusive: 0n,
        upperExclusive: BigInt(ids[4] as string) + 1n,
        onMessages: async () => {},
      }),
    ).rejects.toMatchObject({ failure: "NoProgress" });
    expect(port.getMessagesBefore).toHaveBeenCalledTimes(2);
  });

  it("stops promptly when aborted", async () => {
    const d = new FakeDiscord();
    const ids = seed(d, 500);
    const controller = new AbortController();
    let pages = 0;
    await expect(
      walkHistoryRange({
        port: d,
        channelId: CH,
        lowerExclusive: 0n,
        upperExclusive: BigInt(ids[499] as string) + 1n,
        signal: controller.signal,
        onMessages: async () => {
          pages += 1;
          if (pages === 2) controller.abort();
        },
      }),
    ).rejects.toThrow();
    expect(d.count("getMessagesBefore")).toBe(2);
  });

  it("transient failure carries a resumable cursor; resuming delivers the rest", async () => {
    const d = new FakeDiscord();
    const ids = seed(d, 350);
    const lower = BigInt(ids[0] as string);
    const upper = BigInt(ids[349] as string) + 1n;
    const delivered: string[] = [];
    let call = 0;
    d.historyHook = () => (++call === 3 ? transient : undefined);
    const onMessages = async (msgs: HistoryMessage[]) => {
      delivered.push(...msgs.map((m) => m.id));
    };
    const err = await walkHistoryRange({
      port: d,
      channelId: CH,
      lowerExclusive: lower,
      upperExclusive: upper,
      onMessages,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HistoryWalkError);
    const { cursor, failure } = err as HistoryWalkError;
    expect(failure).toBe("Transient");
    expect(delivered).toHaveLength(200);
    const r = await walkHistoryRange({
      port: d,
      channelId: CH,
      lowerExclusive: lower,
      upperExclusive: cursor,
      onMessages,
    });
    expect(r.outcome).toBe("complete");
    expect(new Set(delivered).size).toBe(349);
  });

  it("returns immediately for an empty range", async () => {
    const d = new FakeDiscord();
    const { result } = await collect(d, 10n, 10n);
    expect(result.pages).toBe(0);
    expect(d.count("getMessagesBefore")).toBe(0);
  });
});
