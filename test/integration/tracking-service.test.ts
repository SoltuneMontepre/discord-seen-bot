import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectView } from "../../src/app/view.ts";
import { createApp, type TestApp } from "../helpers/app.ts";
import { HOUR, MIN, T0 } from "../helpers/domain.ts";
import { transient } from "../helpers/fake-discord.ts";
import {
  AUTHOR,
  CHANNEL,
  GUILD,
  msg,
  reaction,
  startTracked,
  typing,
} from "../helpers/scenario.ts";

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

async function states(id: number) {
  const view = await app.repo.loadView(id);
  if (!view) throw new Error("missing view");
  return Object.fromEntries(projectView(view).map((r) => [r.userId, r.state]));
}

describe("startTracking", () => {
  it("creates the row, posts a reply companion with a nonce and stores its id + hash", async () => {
    const r = await startTracked(app);
    expect(r.tracked).toMatchObject({
      createdAt: T0,
      weakWindowEndsAt: T0 + 2 * HOUR,
      expiresAt: T0 + 7 * 24 * HOUR,
      statusMessageId: r.statusMessageId,
    });
    const companion = app.discord.companions.get(r.statusMessageId);
    expect(companion).toMatchObject({ replyTo: r.sourceId, nonce: `sb1t${r.tracked.id}` });
    const stored = await app.repo.getTracked(r.tracked.id);
    expect(stored?.renderedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await app.repo.listTargets(r.tracked.id)).toHaveLength(2);
  });

  it("source deleted before the companion post: rolls back row + targets", async () => {
    app.discord.createResults.push({ ok: false, error: { kind: "SourceMissing" } });
    app.discord.addMessage(CHANNEL, "777", AUTHOR);
    const r = await app.service.startTracking({
      guildId: GUILD,
      channelId: CHANNEL,
      parentChannelId: null,
      sourceMessageId: "777",
      sourceAuthorId: AUTHOR,
      sourceCreatedAt: T0 - MIN,
      creatorUserId: AUTHOR,
      targets: ["1"],
    });
    expect(r).toEqual({ kind: "create_failed", error: { kind: "SourceMissing" } });
    expect(await app.repo.findActiveBySource("777")).toBeUndefined();
    expect(await app.repo.listActive()).toEqual([]);
    expect(await app.repo.listTargets(1)).toEqual([]);
  });

  it("in-flight duplicate gets being_set_up (never a jump link)", async () => {
    let release = () => {};
    app.discord.createGate = new Promise<void>((r) => {
      release = r;
    });
    app.discord.addMessage(CHANNEL, "888", AUTHOR);
    const input = {
      guildId: GUILD,
      channelId: CHANNEL,
      parentChannelId: null,
      sourceMessageId: "888",
      sourceAuthorId: AUTHOR,
      sourceCreatedAt: T0 - MIN,
      creatorUserId: AUTHOR,
      targets: ["1"],
    };
    const first = app.service.startTracking(input);
    await vi.waitFor(() => expect(app.discord.count("createCompanion")).toBe(1));
    expect(await app.service.startTracking(input)).toEqual({ kind: "being_set_up" });
    app.discord.createGate = null;
    release();
    expect((await first).kind).toBe("started");
  });

  describe("stale companion on re-track", () => {
    it("companion deleted while offline → stale row stopped, new tracking created", async () => {
      const r1 = await startTracked(app);
      app.discord.deleteStored(CHANNEL, r1.statusMessageId);
      const r2 = await app.service.startTracking(r1.input);
      expect(r2.kind).toBe("started");
      if (r2.kind !== "started") return;
      expect(r2.tracked.id).not.toBe(r1.tracked.id);
      expect((await app.repo.getTracked(r1.tracked.id))?.stopReason).toBe("status_deleted");
      expect(app.discord.count("createCompanion")).toBe(2);
      expect((await app.repo.listActive()).map((t) => t.id)).toEqual([r2.tracked.id]);
    });

    it("companion exists → already, no new row", async () => {
      const r1 = await startTracked(app);
      const r2 = await app.service.startTracking(r1.input);
      expect(r2).toMatchObject({ kind: "already", statusMessageId: r1.statusMessageId });
      expect(app.discord.count("createCompanion")).toBe(1);
    });

    it("transient lookup failure → verify_failed, nothing created, old row untouched", async () => {
      const r1 = await startTracked(app);
      app.discord.getMessageOverrides.set(r1.statusMessageId, transient);
      expect(await app.service.startTracking(r1.input)).toEqual({ kind: "verify_failed" });
      expect((await app.repo.getTracked(r1.tracked.id))?.stoppedAt).toBeNull();
      expect(app.discord.count("createCompanion")).toBe(1);
    });

    it("two concurrent re-tracks create exactly one new active row", async () => {
      const r1 = await startTracked(app);
      app.discord.deleteStored(CHANNEL, r1.statusMessageId);
      const results = await Promise.all([
        app.service.startTracking(r1.input),
        app.service.startTracking(r1.input),
      ]);
      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toContain("started");
      expect(kinds.filter((k) => k === "started")).toHaveLength(1);
      expect(await app.repo.listActive()).toHaveLength(1);
    });
  });
});

describe("recordSignal", () => {
  it("direct reply → DIRECT_REPLY keyed by the reply id; non-targets ignored", async () => {
    const { tracked, sourceId } = await startTracked(app);
    const reply = msg("1", { replyTo: sourceId, at: T0 + MIN });
    await app.service.recordSignal(reply);
    await app.service.recordSignal(msg("9", { replyTo: sourceId, at: T0 + MIN }));
    const ev = await app.repo.listEvidence(tracked.id);
    expect(ev.filter((e) => e.kind === "DIRECT_REPLY")).toEqual([
      expect.objectContaining({
        userId: "1",
        sourceKey: reply.messageId,
        occurredAt: reply.occurredAt,
      }),
    ]);
    expect(ev.some((e) => e.userId === "9")).toBe(false);
    expect((await states(tracked.id))["1"]).toBe("INTERACTED");
  });

  it("weak evidence only inside [createdAt, createdAt + 2h]", async () => {
    const { tracked } = await startTracked(app);
    await app.service.recordSignal(typing("1", T0 + MIN));
    await app.service.recordSignal(msg("2", { at: T0 + 2 * HOUR + 1000 }));
    await app.service.recordSignal(typing("2", T0 - 1000));
    const ev = await app.repo.listEvidence(tracked.id);
    expect(ev.map((e) => [e.userId, e.kind])).toEqual([["1", "TYPING_AFTER"]]);
  });

  it("weak evidence respects target.addedAt at write time", async () => {
    const { tracked } = await startTracked(app, { targets: ["1"] });
    await app.repo.replaceTargets(tracked.id, ["1", "3"], AUTHOR, T0 + 30 * MIN);
    await app.service.recordSignal(msg("3", { at: T0 + 10 * MIN }));
    expect(await app.repo.listEvidence(tracked.id)).toEqual([]);
    await app.service.recordSignal(msg("3", { at: T0 + 40 * MIN }));
    expect((await app.repo.listEvidence(tracked.id)).map((e) => e.kind)).toEqual([
      "CHANNEL_MESSAGE_AFTER",
    ]);
  });

  it("activity in another channel (e.g. the parent of a thread) is not counted", async () => {
    const { tracked } = await startTracked(app, {
      channelId: "thread-1",
      parentChannelId: CHANNEL,
    });
    await app.service.recordSignal(typing("1", T0 + MIN, CHANNEL));
    await app.service.recordSignal(msg("1", { at: T0 + MIN, channelId: CHANNEL }));
    expect(await app.repo.listEvidence(tracked.id)).toEqual([]);
    await app.service.recordSignal(typing("1", T0 + MIN, "thread-1"));
    expect(await app.repo.listEvidence(tracked.id)).toHaveLength(1);
  });

  it("reactions: add → INTERACTED with null time; remove → fallback", async () => {
    const { tracked, sourceId } = await startTracked(app);
    await app.service.recordSignal(reaction("REACTION_ADD", "1", sourceId));
    const [e] = await app.repo.listEvidence(tracked.id);
    expect(e).toMatchObject({ kind: "DIRECT_REACTION", occurredAt: null, observedAt: T0 });
    expect((await states(tracked.id))["1"]).toBe("INTERACTED");
    await app.service.recordSignal(reaction("REACTION_REMOVE", "1", sourceId));
    expect((await states(tracked.id))["1"]).toBe("UNKNOWN");
  });

  it("REACTION_REMOVE_EMOJI and REMOVE_ALL clear matching rows", async () => {
    const { tracked, sourceId } = await startTracked(app);
    await app.service.recordSignal(reaction("REACTION_ADD", "1", sourceId, "👍|0"));
    await app.service.recordSignal(reaction("REACTION_ADD", "1", sourceId, "👍|1"));
    await app.service.recordSignal(reaction("REACTION_ADD", "2", sourceId, "🎉|0"));
    await app.service.recordSignal({
      t: "REACTION_REMOVE_EMOJI",
      channelId: CHANNEL,
      messageId: sourceId,
      emojiKey: "👍",
    });
    expect((await app.repo.listEvidence(tracked.id)).map((e) => e.sourceKey)).toEqual(["🎉|0"]);
    await app.service.recordSignal({
      t: "REACTION_REMOVE_ALL",
      channelId: CHANNEL,
      messageId: sourceId,
    });
    expect(await app.repo.listEvidence(tracked.id)).toEqual([]);
  });

  describe("reply deletion", () => {
    it("one reply deleted → fallback; replay is idempotent", async () => {
      const { tracked, sourceId } = await startTracked(app);
      const r = msg("1", { replyTo: sourceId, at: T0 + MIN });
      await app.service.recordSignal(r);
      await app.service.recordSignal(typing("1", T0 + 2 * MIN));
      await app.service.recordSignal({
        t: "MESSAGES_DELETED",
        channelId: CHANNEL,
        messageIds: [r.messageId],
      });
      expect((await states(tracked.id))["1"]).toBe("LIKELY");
      const markDirty = vi.spyOn(app.scheduler, "markDirty");
      await app.service.recordSignal({
        t: "MESSAGES_DELETED",
        channelId: CHANNEL,
        messageIds: [r.messageId],
      });
      expect(markDirty).not.toHaveBeenCalled();
    });

    it("two replies, bulk delete of one → still INTERACTED; deleting the last → fallback", async () => {
      const { tracked, sourceId } = await startTracked(app, { targets: ["1"] });
      const a = msg("1", { replyTo: sourceId, at: T0 + MIN });
      const b = msg("1", { replyTo: sourceId, at: T0 + 2 * MIN });
      await app.service.recordSignal(a);
      await app.service.recordSignal(b);
      await app.service.recordSignal({
        t: "MESSAGES_DELETED",
        channelId: CHANNEL,
        messageIds: [a.messageId, "123"],
      });
      expect((await states(tracked.id))["1"]).toBe("INTERACTED");
      await app.service.recordSignal({
        t: "MESSAGES_DELETED",
        channelId: CHANNEL,
        messageIds: [b.messageId],
      });
      // CHANNEL_MESSAGE_AFTER from the replies themselves keeps LIKELY (not reversible, §18 A4)
      expect((await states(tracked.id))["1"]).toBe("LIKELY");
    });
  });

  it("source deleted → source_deleted and a frozen render", async () => {
    const { tracked, sourceId, statusMessageId } = await startTracked(app);
    await app.service.recordSignal({
      t: "MESSAGES_DELETED",
      channelId: CHANNEL,
      messageIds: [sourceId],
    });
    const t = await app.repo.getTracked(tracked.id);
    expect(t?.stopReason).toBe("source_deleted");
    const body = JSON.stringify(app.discord.companions.get(statusMessageId)?.body);
    expect(body).toContain("Original message was deleted");
    expect(body).not.toContain("sb1:ack");
  });

  it("companion deleted → status_deleted with no render", async () => {
    const { tracked, statusMessageId } = await startTracked(app);
    await app.service.recordSignal({
      t: "MESSAGES_DELETED",
      channelId: CHANNEL,
      messageIds: [statusMessageId],
    });
    expect((await app.repo.getTracked(tracked.id))?.stopReason).toBe("status_deleted");
    expect(app.discord.count("editCompanion")).toBe(0);
  });

  it("parent channel deletion stops tracking inside its threads", async () => {
    const a = await startTracked(app, { channelId: "thread-1", parentChannelId: CHANNEL });
    const b = await startTracked(app);
    await app.service.recordSignal({ t: "CHANNEL_DELETED", channelId: CHANNEL });
    expect((await app.repo.getTracked(a.tracked.id))?.stopReason).toBe("channel_deleted");
    expect((await app.repo.getTracked(b.tracked.id))?.stopReason).toBe("channel_deleted");
  });

  it("GUILD_REMOVED purges the guild immediately", async () => {
    await startTracked(app);
    await app.service.recordSignal({ t: "GUILD_REMOVED", guildId: GUILD });
    expect(await app.repo.listActive()).toEqual([]);
  });

  it("message write failure → message hook; typing failure → logged only", async () => {
    const { sourceId } = await startTracked(app);
    const onMessage = vi.fn();
    const onReaction = vi.fn();
    app.service.hooks = { onMessageSignalFailed: onMessage, onReactionSignalFailed: onReaction };
    vi.spyOn(app.repo, "recordEvidence").mockRejectedValue(new Error("disk I/O error"));
    await app.service.recordSignal(msg("1", { replyTo: sourceId }));
    await app.service.recordSignal(typing("1"));
    await app.service.recordSignal(reaction("REACTION_ADD", "1", sourceId));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onReaction).toHaveBeenCalledWith(sourceId);
  });
});

describe("acknowledge / undo", () => {
  it("target ack → card with CONFIRMED; non-target → no writes; double → already", async () => {
    const { tracked } = await startTracked(app);
    const r = await app.service.acknowledge(tracked.id, "1", T0 + MIN);
    expect(r.kind).toBe("acknowledged");
    if (r.kind === "acknowledged")
      expect(JSON.stringify(r.card.body)).toContain("✅ **Confirmed**\\n<@1>");
    expect(await app.service.acknowledge(tracked.id, "9", T0)).toEqual({ kind: "not_target" });
    expect((await app.repo.listAcks(tracked.id)).map((a) => a.userId)).toEqual(["1"]);
    expect(await app.service.acknowledge(tracked.id, "1", T0 + 2 * MIN)).toMatchObject({
      kind: "already",
      ack: { acknowledgedAt: T0 + MIN },
    });
    expect(await app.service.undo(tracked.id, "1", T0 + 3 * MIN)).toBe(true);
    expect((await states(tracked.id))["1"]).toBe("UNKNOWN");
  });

  it("unknown or stopped tracking", async () => {
    const { tracked } = await startTracked(app);
    expect(await app.service.acknowledge(9999, "1", T0)).toEqual({ kind: "not_found" });
    await app.service.stop(tracked.id, "manual", AUTHOR);
    expect((await app.service.acknowledge(tracked.id, "1", T0)).kind).toBe("stopped");
  });
});
