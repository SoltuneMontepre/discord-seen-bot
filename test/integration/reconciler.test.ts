import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Signal } from "../../src/domain/signals.ts";
import { snowflakeFromTime, timestampOf } from "../../src/domain/snowflake.ts";
import { createApp, type TestApp } from "../helpers/app.ts";
import { MIN, T0 } from "../helpers/domain.ts";
import { notFound, permanent, snowflakeAt, transient } from "../helpers/fake-discord.ts";
import { AUTHOR, CHANNEL, GUILD, msg, startTracked } from "../helpers/scenario.ts";
import { tempDbPath } from "../helpers/tmp.ts";

let app: TestApp;

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
  app = await createApp();
});
afterEach(async () => {
  await app.dispose();
  vi.useRealTimers();
});

/** Stores a channel message (and its signals) in the fake history. */
function post(
  authorId: string,
  at: number,
  opts: { replyTo?: string; channelId?: string; seq?: number } = {},
) {
  const id = snowflakeAt(at, opts.seq ?? 1);
  const channelId = opts.channelId ?? CHANNEL;
  const signal: Signal = {
    t: "MESSAGE",
    guildId: GUILD,
    channelId,
    messageId: id,
    authorId,
    occurredAt: timestampOf(id),
    ...(opts.replyTo ? { replyToMessageId: opts.replyTo } : {}),
  };
  app.discord.addMessage(channelId, id, authorId, [signal]);
  return id;
}

async function evidenceOf(trackedId: number) {
  return (await app.repo.listEvidence(trackedId)).map(
    (e) => `${e.userId}:${e.kind}:${e.occurredAt === null ? "-" : e.occurredAt - T0}`,
  );
}

async function makeHealthy(at: number) {
  vi.setSystemTime(at);
  app.health.onReady();
  app.health.gapRecoveryCompleted();
  await app.health.tick();
}

describe("gap recovery", () => {
  it("(c) 20-minute disconnect with the process alive, then fresh READY: gap events are recovered", async () => {
    const { tracked, sourceId } = await startTracked(app, { targets: ["1"] });
    await makeHealthy(T0 + MIN); // W = T0 + 1m
    vi.setSystemTime(T0 + MIN + 30_000);
    app.health.onClosed(1006);
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(MIN);
      await app.health.tick();
    }
    expect(await app.repo.getWatermark()).toBe(T0 + MIN);

    const replyId = post("1", T0 + 10 * MIN, { replyTo: sourceId });
    post("1", T0 + 12 * MIN, { seq: 2 });

    const readyAt = Date.now();
    const { readyAt: r } = app.health.onReady();
    expect(r).toBe(readyAt);
    await app.reconciler.onFreshSession(readyAt);

    const firstWalk = app.discord.calls.find((c) => c.method === "getMessagesBefore");
    expect(firstWalk?.args[1]).toBe(snowflakeFromTime(readyAt + 60_000));
    expect(app.discord.calls.some((c) => c.method === "getMessagesAfter")).toBe(false);
    expect(await evidenceOf(tracked.id)).toEqual(
      expect.arrayContaining([`1:DIRECT_REPLY:${10 * MIN}`, `1:CHANNEL_MESSAGE_AFTER:${10 * MIN}`]),
    );
    expect(replyId).toBeDefined();

    // watermark stayed frozen until recovery completed; now it may advance again
    expect(app.health.gapRecoveryPending).toBe(false);
    app.health.onHeartbeatAck(Date.now());
    await app.health.tick();
    expect(await app.repo.getWatermark()).toBe(Date.now());
  });

  it("lower bound is snowflakeFromTime(W − 5 min): events before it are not rescanned", async () => {
    const { tracked } = await startTracked(app, { targets: ["1"] });
    await makeHealthy(T0 + 30 * MIN); // W
    post("1", T0 + 20 * MIN); // before W − 5m: already covered by live delivery (not re-read)
    post("1", T0 + 27 * MIN, { seq: 3 }); // inside the overlap
    vi.setSystemTime(T0 + 40 * MIN);
    app.health.onReady();
    await app.reconciler.onFreshSession(Date.now());
    expect(await evidenceOf(tracked.id)).toEqual([`1:CHANNEL_MESSAGE_AFTER:${27 * MIN}`]);
  });

  it("gap scan through the paginator reaches replies in both the newest and oldest pages", async () => {
    const { tracked, sourceId } = await startTracked(app, { targets: ["1", "2"] });
    await makeHealthy(T0);
    const oldReply = post("1", T0 + 1000, { replyTo: sourceId, seq: 1 });
    for (let i = 0; i < 150; i++) post("50", T0 + 2000 + i * 10, { seq: 10 + i });
    const newReply = post("2", T0 + 60_000, { replyTo: sourceId, seq: 999 });
    vi.setSystemTime(T0 + 10 * MIN);
    app.health.onReady();
    await app.reconciler.onFreshSession(Date.now());
    const replies = (await app.repo.listEvidence(tracked.id))
      .filter((e) => e.kind === "DIRECT_REPLY")
      .map((e) => e.sourceKey);
    expect(replies.sort()).toEqual([oldReply, newReply].sort());
    expect(app.discord.count("getMessagesBefore")).toBeGreaterThanOrEqual(2);
  });

  it("transient channel failure keeps the watermark frozen until the retry succeeds", async () => {
    const { tracked, sourceId } = await startTracked(app, { targets: ["1"] });
    await makeHealthy(T0);
    post("1", T0 + MIN, { replyTo: sourceId });
    app.discord.historyFailures.push(transient);
    vi.setSystemTime(T0 + 5 * MIN);
    app.health.onReady();
    await app.reconciler.onFreshSession(Date.now());
    expect(app.health.gapRecoveryPending).toBe(true);
    expect(await app.health.tick()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(app.health.gapRecoveryPending).toBe(false));
    expect((await evidenceOf(tracked.id)).some((e) => e.startsWith("1:DIRECT_REPLY"))).toBe(true);
  });

  it("a permanent channel failure does not block completion", async () => {
    await startTracked(app, { targets: ["1"] });
    await makeHealthy(T0);
    app.discord.historyFailures.push(permanent);
    vi.setSystemTime(T0 + 5 * MIN);
    app.health.onReady();
    await app.reconciler.onFreshSession(Date.now());
    expect(app.health.gapRecoveryPending).toBe(false);
  });

  it("second fresh READY during a scan aborts the first and rescans from the same W", async () => {
    await startTracked(app, { targets: ["1"] });
    await makeHealthy(T0);
    for (let i = 0; i < 300; i++) post("50", T0 + 1000 + i, { seq: i });
    let calls = 0;
    app.discord.historyHook = () => {
      calls += 1;
      if (calls === 2) {
        app.health.onReady();
        void app.reconciler.onFreshSession(Date.now());
      }
      return undefined;
    };
    vi.setSystemTime(T0 + 5 * MIN);
    app.health.onReady();
    await app.reconciler.onFreshSession(Date.now());
    await vi.waitFor(() => expect(app.health.gapRecoveryPending).toBe(false));
    expect(await app.repo.getWatermark()).toBe(T0);
  });

  it("crash during recovery: the next instance rescans from the same W", async () => {
    const { path, cleanup } = tempDbPath("crash-recovery");
    const a = await createApp({ dbPath: path });
    const { sourceId } = await startTracked(a, { targets: ["1"] });
    vi.setSystemTime(T0);
    a.health.onReady();
    a.health.gapRecoveryCompleted();
    await a.health.tick();
    a.discord.historyFailures.push(transient);
    vi.setSystemTime(T0 + 5 * MIN);
    a.health.onReady();
    await a.reconciler.onFreshSession(Date.now());
    expect(a.health.gapRecoveryPending).toBe(true);
    await a.dispose(); // crash before the retry

    const b = await createApp({ dbPath: path, discord: a.discord });
    const reply = snowflakeAt(T0 + 2 * MIN, 5);
    b.discord.addMessage(CHANNEL, reply, "1", [
      {
        t: "MESSAGE",
        guildId: GUILD,
        channelId: CHANNEL,
        messageId: reply,
        authorId: "1",
        occurredAt: T0 + 2 * MIN,
        replyToMessageId: sourceId,
      },
    ]);
    expect(await b.repo.getWatermark()).toBe(T0);
    b.health.onReady();
    await b.reconciler.onFreshSession(Date.now());
    const [t] = await b.repo.listActive();
    expect((await b.repo.listEvidence(t?.id ?? 0)).some((e) => e.sourceKey === reply)).toBe(true);
    await b.dispose();
    cleanup();
  });

  it("message write failure freezes the watermark; the scheduled rescan recovers the reply", async () => {
    const { tracked, sourceId } = await startTracked(app, { targets: ["1"] });
    await makeHealthy(T0);
    vi.setSystemTime(T0 + MIN);
    const replySignal = msg("1", { replyTo: sourceId, at: T0 + MIN });
    app.discord.addMessage(CHANNEL, replySignal.messageId, "1", [replySignal]);
    const spy = vi
      .spyOn(app.repo, "recordEvidence")
      .mockRejectedValueOnce(new Error("SQLITE_IOERR"));
    await app.service.recordSignal(replySignal);
    spy.mockRestore();
    expect(app.health.gapRecoveryPending).toBe(true);
    expect(await app.health.tick()).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.waitFor(() => expect(app.health.gapRecoveryPending).toBe(false));
    expect((await evidenceOf(tracked.id)).some((e) => e.startsWith("1:DIRECT_REPLY"))).toBe(true);
  });

  it("reconciliation before a target was added: only post-addedAt weak evidence is stored", async () => {
    const { tracked, sourceId } = await startTracked(app, { targets: ["1"] });
    await app.repo.replaceTargets(tracked.id, ["1", "3"], AUTHOR, T0 + 30 * MIN);
    post("3", T0 + 10 * MIN, { seq: 1 });
    post("3", T0 + 5 * MIN, { replyTo: sourceId, seq: 2 });
    post("3", T0 + 40 * MIN, { seq: 3 });
    await app.repo.setWatermark(T0 - MIN);
    vi.setSystemTime(T0 + 50 * MIN);
    app.health.onReady();
    await app.reconciler.onFreshSession(Date.now());
    const ev = (await evidenceOf(tracked.id)).filter((e) => e.startsWith("3:"));
    expect(ev.sort()).toEqual(
      [`3:CHANNEL_MESSAGE_AFTER:${40 * MIN}`, `3:DIRECT_REPLY:${5 * MIN}`].sort(),
    );
  });
});

describe("backfills", () => {
  it("initial backfill upper bound is stable: a retry after 800 newer messages still finds an early reply", async () => {
    const { tracked, sourceId } = await startTracked(app, { targets: ["1"] });
    const early = post("1", T0 + 5_000, { replyTo: sourceId, seq: 1 });
    // 50 messages right after the source, before tracking start snapshot
    for (let i = 0; i < 50; i++) post("50", T0 - 50_000 + i * 100, { seq: 100 + i });
    for (let i = 0; i < 800; i++) post("50", T0 + 10 * MIN + i * 100, { seq: 1000 + i });
    vi.setSystemTime(T0 + 3 * 60 * MIN);
    await app.reconciler.initialBackfill(tracked.id);
    const replies = (await app.repo.listEvidence(tracked.id)).filter(
      (e) => e.kind === "DIRECT_REPLY",
    );
    expect(replies.map((e) => e.sourceKey)).toEqual([early]);
    expect((await app.repo.getTracked(tracked.id))?.initialBackfillAt).toBe(Date.now());
    const firstCursor = app.discord.calls.find((c) => c.method === "getMessagesBefore")?.args[1];
    expect(firstCursor).toBe(snowflakeFromTime(tracked.createdAt + 60_000));
  });

  it("initial backfill failure leaves initial_backfill_at NULL; next READY retries", async () => {
    const { tracked } = await startTracked(app, { targets: ["1"] });
    app.discord.historyFailures.push(transient);
    await app.reconciler.initialBackfill(tracked.id);
    expect((await app.repo.getTracked(tracked.id))?.initialBackfillAt).toBeNull();
    expect(
      app.logger.entries.some(
        (e) => e.level === "warn" && e.msg?.includes("initial backfill failed"),
      ),
    ).toBe(true);
    app.health.onReady();
    await app.reconciler.onFreshSession(Date.now());
    expect((await app.repo.getTracked(tracked.id))?.initialBackfillAt).not.toBeNull();
  });

  it("backfillTargets walks (source, addedAt + 60s) for the added users only", async () => {
    const { tracked, sourceId } = await startTracked(app, { targets: ["1"] });
    post("1", T0 + MIN, { replyTo: sourceId, seq: 1 });
    post("3", T0 + 2 * MIN, { replyTo: sourceId, seq: 2 });
    vi.setSystemTime(T0 + 30 * MIN);
    await app.repo.replaceTargets(tracked.id, ["1", "3"], AUTHOR, Date.now());
    await app.reconciler.backfillTargets(tracked.id, ["3"]);
    expect(await evidenceOf(tracked.id)).toEqual([`3:DIRECT_REPLY:${2 * MIN}`]);
    const firstCursor = app.discord.calls.find((c) => c.method === "getMessagesBefore")?.args[1];
    expect(firstCursor).toBe(snowflakeFromTime(T0 + 30 * MIN + 60_000));
  });
});

describe("reaction pass", () => {
  it("inserts current target reactions with null occurrence and removes stale rows", async () => {
    const { tracked, sourceId } = await startTracked(app, { targets: ["1", "2"] });
    await app.repo.recordEvidence(
      {
        trackedMessageId: tracked.id,
        userId: "2",
        kind: "DIRECT_REACTION",
        sourceKey: "🎉|0",
        occurredAt: null,
        observedAt: T0,
      },
      () => true,
    );
    app.discord.addReaction(CHANNEL, sourceId, "👍", 0, { id: "1" });
    app.discord.addReaction(CHANNEL, sourceId, "👍", 0, { id: "77", bot: true });
    vi.setSystemTime(T0 + 5 * MIN);
    expect(await app.reconciler.reactionPass(tracked)).toBe("ok");
    const ev = await app.repo.listEvidence(tracked.id);
    expect(ev).toEqual([
      expect.objectContaining({
        userId: "1",
        sourceKey: "👍|0",
        occurredAt: null,
        observedAt: T0 + 5 * MIN,
      }),
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    const card = JSON.stringify([...app.discord.companions.values()][0]?.body);
    expect(card).toContain('<@1> · reacted"'); // last row in group; no time rendered
  });

  it("source deleted while offline → source_deleted + frozen card, no warning", async () => {
    const { tracked, sourceId, statusMessageId } = await startTracked(app, { targets: ["1"] });
    app.discord.deleteStored(CHANNEL, sourceId);
    app.health.onReady();
    await app.reconciler.onFreshSession(Date.now());
    expect((await app.repo.getTracked(tracked.id))?.stopReason).toBe("source_deleted");
    const body = JSON.stringify(app.discord.companions.get(statusMessageId)?.body);
    expect(body).toContain("Original message was deleted");
    expect(body).not.toContain("sb1:ack");
    expect(app.logger.entries.filter((e) => e.level === "warn")).toEqual([]);
  });

  it("a transient source lookup during a fresh session is retried after 60 s", async () => {
    const { tracked, sourceId } = await startTracked(app, { targets: ["1"] });
    app.discord.addReaction(CHANNEL, sourceId, "👍", 0, { id: "1" });
    app.discord.getMessageOnce.set(sourceId, [transient]);
    await app.repo.setInitialBackfillAt(tracked.id, T0); // isolate the scheduled retry
    app.health.onReady();
    await app.reconciler.onFreshSession(Date.now());
    expect(await app.repo.listEvidence(tracked.id)).toEqual([]);
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.waitFor(async () => expect(await app.repo.listEvidence(tracked.id)).toHaveLength(1));
  });

  it("an incomplete listing never deletes stored rows", async () => {
    const { tracked, sourceId } = await startTracked(app, { targets: ["1"] });
    await app.repo.recordEvidence(
      {
        trackedMessageId: tracked.id,
        userId: "1",
        kind: "DIRECT_REACTION",
        sourceKey: "👍|0",
        occurredAt: null,
        observedAt: T0,
      },
      () => true,
    );
    app.discord.addReaction(CHANNEL, sourceId, "👍", 0, { id: "1" });
    vi.spyOn(app.discord, "getReactionUsers").mockResolvedValueOnce(transient);
    expect(await app.reconciler.reactionPass(tracked)).toBe("failed");
    expect(await app.repo.listEvidence(tracked.id)).toHaveLength(1);
  });
});

describe("verifyReplyEvidence", () => {
  it("checks all 450 rows (beyond the first page) with concurrency ≤ 5; transient rows kept", async () => {
    const trackedIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { tracked } = await startTracked(app, { targets: ["1", "2", "3"] });
      trackedIds.push(tracked.id);
    }
    const replyIds: string[] = [];
    for (let i = 0; i < 450; i++) {
      const id = snowflakeAt(T0 + 1000 + i, 1);
      replyIds.push(id);
      app.discord.addMessage(CHANNEL, id, "1");
      await app.repo.recordEvidence(
        {
          trackedMessageId: trackedIds[i % 3] as number,
          userId: String(1 + (i % 3)),
          kind: "DIRECT_REPLY",
          sourceKey: id,
          occurredAt: T0 + 1000 + i,
          observedAt: T0,
        },
        () => true,
      );
    }
    // keyset order = (tracked, user, key); pick rows by their position in that order
    const ordered: Awaited<ReturnType<typeof app.repo.pageActiveReplies>> = [];
    let cursor: (typeof ordered)[number] | null = null;
    for (;;) {
      const page = await app.repo.pageActiveReplies(cursor, 1000);
      ordered.push(...page);
      if (page.length < 1000) break;
      cursor = page.at(-1) ?? null;
    }
    const at = (n: number) => ordered[n - 1]?.sourceKey as string;
    for (const n of [201, 350, 449]) app.discord.getMessageOverrides.set(at(n), notFound);
    app.discord.getMessageOverrides.set(at(300), transient);
    app.discord.getMessageDelayMs = 1;

    const run = app.reconciler.verifyReplyEvidence();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await run;

    expect(result).toEqual({ checked: 450, removed: 3 });
    const lookedUp = new Set(
      app.discord.calls.filter((c) => c.method === "getMessage").map((c) => c.args[1]),
    );
    for (const id of replyIds) expect(lookedUp.has(id)).toBe(true);
    expect(app.discord.maxConcurrentGetMessage).toBeLessThanOrEqual(5);
    const remaining = new Set(
      (await app.repo.pageActiveReplies(null, 1000)).map((r) => r.sourceKey),
    );
    for (const n of [201, 350, 449]) expect(remaining.has(at(n))).toBe(false);
    expect(remaining.has(at(300))).toBe(true);
    expect(
      app.logger.entries.some((e) => e.msg?.includes("reply verification lookup failed")),
    ).toBe(true);

    // transient row is retried on the next fresh READY
    app.discord.getMessageOverrides.delete(at(300));
    app.discord.calls = [];
    const again = app.reconciler.verifyReplyEvidence();
    await vi.advanceTimersByTimeAsync(10_000);
    await again;
    expect(app.discord.calls.some((c) => c.args[1] === at(300))).toBe(true);
  });
});
