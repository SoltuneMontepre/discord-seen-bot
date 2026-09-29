import { ChannelType, PermissionFlagsBits } from "@discordjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type TestApp } from "../helpers/app.ts";
import { T0 } from "../helpers/domain.ts";
import {
  APP_ID,
  componentInteraction,
  type FakeResponder,
  makeRouter,
  trackSeenInteraction,
} from "../helpers/interactions.ts";
import { AUTHOR, CHANNEL, nextId } from "../helpers/scenario.ts";
import { tempDbPath } from "../helpers/tmp.ts";

let app: TestApp;
let router: ReturnType<typeof makeRouter>["router"];
let responder: FakeResponder;

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
  app = await createApp();
  ({ router, responder } = makeRouter(app));
});
afterEach(async () => {
  await app.dispose();
  vi.useRealTimers();
});

function source(mentions: { id: string; bot?: boolean }[] = [], authorId = AUTHOR) {
  const id = nextId(T0 - 60_000);
  app.discord.addMessage(CHANNEL, id, authorId);
  return { id, authorId, mentions };
}

async function trackWith(mentions: { id: string; bot?: boolean }[]) {
  const src = source(mentions);
  await router.handle(trackSeenInteraction(src));
  const [started] = await app.repo.listActive();
  if (!started?.statusMessageId) throw new Error("not started");
  // let the background initial backfill settle so later snapshots are stable
  await vi.waitFor(async () =>
    expect((await app.repo.getTracked(started.id))?.initialBackfillAt).not.toBeNull(),
  );
  const tracked = (await app.repo.getTracked(started.id)) ?? started;
  return { src, tracked, statusMessageId: started.statusMessageId };
}

const kinds = () => responder.calls.map((c) => c.kind);

describe("Track Seen", () => {
  it("with mentions: defers, starts, replies with a jump link; targets exclude bots and the author", async () => {
    const src = source([
      { id: "1" },
      { id: "2" },
      { id: "77", bot: true },
      { id: AUTHOR },
      { id: "1" },
    ]);
    await router.handle(trackSeenInteraction(src));
    expect(kinds()).toEqual(["deferEphemeral", "editReply"]);
    const [tracked] = await app.repo.listActive();
    expect(responder.text()).toBe(
      `Tracking 2 people · [status card](https://discord.com/channels/500/600/${tracked?.statusMessageId})`,
    );
    expect((await app.repo.listTargets(tracked?.id ?? 0)).map((t) => t.userId)).toEqual(["1", "2"]);
    const companion = app.discord.companions.get(tracked?.statusMessageId ?? "");
    expect(companion?.replyTo).toBe(src.id);
  });

  it("replies before the paginated backfill completes (backfill is off the latency path)", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = app.discord.getMessagesBefore.bind(app.discord);
    vi.spyOn(app.discord, "getMessagesBefore").mockImplementation(async (...a) => {
      await gate;
      return original(...a);
    });
    const src = source([{ id: "1" }]);
    await router.handle(trackSeenInteraction(src));
    expect(kinds()).toEqual(["deferEphemeral", "editReply"]);
    const [tracked] = await app.repo.listActive();
    expect(tracked?.initialBackfillAt).toBeNull();
    release();
    await vi.waitFor(async () =>
      expect((await app.repo.getTracked(tracked?.id ?? 0))?.initialBackfillAt).not.toBeNull(),
    );
  });

  it("no eligible mentions → picker", async () => {
    const src = source([{ id: "77", bot: true }]);
    await router.handle(trackSeenInteraction(src));
    const data = responder.last()?.data;
    expect(data?.content).toBe("Nobody eligible was mentioned. Who needs to acknowledge this?");
    expect(JSON.stringify(data?.components)).toContain(`"custom_id":"sb1:pick:${src.id}"`);
    expect(await app.repo.listActive()).toEqual([]);
  });

  it("already tracked → jump link to the existing companion", async () => {
    const { src, statusMessageId } = await trackWith([{ id: "1" }]);
    await router.handle(trackSeenInteraction(src));
    expect(responder.text()).toContain(`This message is already tracked`);
    expect(responder.text()).toContain(statusMessageId);
    expect(app.discord.count("createCompanion")).toBe(1);
  });

  it("companion deleted while offline → Track Seen again creates a fresh companion", async () => {
    const { src, tracked, statusMessageId } = await trackWith([{ id: "1" }]);
    app.discord.deleteStored(CHANNEL, statusMessageId);
    await router.handle(trackSeenInteraction(src));
    expect((await app.repo.getTracked(tracked.id))?.stopReason).toBe("status_deleted");
    const [fresh] = await app.repo.listActive();
    expect(fresh?.id).not.toBe(tracked.id);
    expect(responder.text()).toContain(fresh?.statusMessageId ?? "missing");
  });

  it("source deleted before the companion post → clear message, nothing persisted", async () => {
    app.discord.createResults.push({ ok: false, error: { kind: "SourceMissing" } });
    const src = source([{ id: "1" }]);
    await router.handle(trackSeenInteraction(src));
    expect(responder.text()).toBe("The original message no longer exists.");
    expect(await app.repo.listActive()).toEqual([]);
    expect(await app.repo.listTargets(1)).toEqual([]);
  });

  it.each([
    [
      "unsupported channel type (voice)",
      { channelType: ChannelType.GuildVoice },
      "Track Seen isn't supported in this kind of channel.",
    ],
    [
      "missing permissions",
      { appPermissions: PermissionFlagsBits.ViewChannel.toString() },
      "I'm missing permissions here: SEND_MESSAGES, READ_MESSAGE_HISTORY.",
    ],
    [
      "thread without SEND_MESSAGES_IN_THREADS",
      {
        channelType: ChannelType.PublicThread,
        appPermissions: (
          PermissionFlagsBits.ViewChannel |
          PermissionFlagsBits.SendMessages |
          PermissionFlagsBits.ReadMessageHistory
        ).toString(),
      },
      "I'm missing permissions here: SEND_MESSAGES_IN_THREADS.",
    ],
    ["DM", { guildId: null }, "Track Seen only works in server channels."],
  ])("rejects %s", async (_n, o, text) => {
    const src = source([{ id: "1" }]);
    await router.handle(trackSeenInteraction(src, o as never));
    expect(responder.text()).toBe(text);
    expect(await app.repo.listActive()).toEqual([]);
  });

  it("rejects tracking the bot's own status card and system messages", async () => {
    await router.handle(
      trackSeenInteraction({ id: nextId(), authorId: APP_ID, mentions: [{ id: "1" }] }),
    );
    expect(responder.text()).toBe("Seen status cards can't be tracked.");
    await router.handle(
      trackSeenInteraction({ id: nextId(), authorId: AUTHOR, type: 6, mentions: [{ id: "1" }] }),
    );
    expect(responder.text()).toBe("This kind of message can't be tracked.");
  });

  it("tracks inside a thread with the parent channel recorded", async () => {
    const id = nextId();
    app.discord.addMessage("thread-9", id, AUTHOR);
    await router.handle(
      trackSeenInteraction(
        { id, authorId: AUTHOR, mentions: [{ id: "1" }] },
        { channelId: "thread-9", channelType: ChannelType.PublicThread, parentId: CHANNEL },
      ),
    );
    const [t] = await app.repo.listActive();
    expect(t).toMatchObject({ channelId: "thread-9", parentChannelId: CHANNEL });
  });
});

describe("picker submit (sb1:pick)", () => {
  async function pick(
    src: { id: string },
    values: string[],
    resolvedUsers: Record<string, { bot?: boolean }>,
  ) {
    await router.handle(componentInteraction(`sb1:pick:${src.id}`, { values, resolvedUsers }));
  }

  it("only a bot and the author → error, picker kept, nothing started", async () => {
    const src = source();
    await pick(src, ["77", AUTHOR], { "77": { bot: true }, [AUTHOR]: {} });
    expect(kinds()).toEqual(["deferUpdate", "editReply"]);
    expect(responder.text()).toMatch(/None of the selected users can be targets/);
    expect(JSON.stringify(responder.last()?.data?.components)).toContain("sb1:pick:");
    expect(await app.repo.listActive()).toEqual([]);
  });

  it("mixed selection: only eligible users; duplicates collapsed; unverifiable dropped", async () => {
    const src = source();
    await pick(src, ["1", "77", "1", "3", AUTHOR], { "1": {}, "77": { bot: true }, [AUTHOR]: {} });
    const [t] = await app.repo.listActive();
    expect((await app.repo.listTargets(t?.id ?? 0)).map((x) => x.userId)).toEqual(["1"]);
    expect(responder.text()).toMatch(/^Tracking 1 person/);
  });

  it("source deleted meanwhile → clear message", async () => {
    await pick({ id: "123456789012345678" }, ["1"], { "1": {} });
    expect(responder.text()).toBe("The original message no longer exists.");
  });
});

describe("acknowledge button", () => {
  it("target → UPDATE_MESSAGE with CONFIRMED; the hash is recorded so no duplicate PATCH follows", async () => {
    const { tracked, statusMessageId } = await trackWith([{ id: "1" }, { id: "2" }]);
    await router.handle(
      componentInteraction(`sb1:ack:${tracked.id}`, { userId: "1", messageId: statusMessageId }),
    );
    const call = responder.last();
    expect(call?.kind).toBe("update");
    expect(JSON.stringify(call?.data)).toContain("✅ **Confirmed**\\n<@1>");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(app.discord.count("editCompanion")).toBe(0);
  });

  it("non-target → ephemeral notice, zero DB writes, card unchanged", async () => {
    const { tracked, statusMessageId } = await trackWith([{ id: "1" }]);
    const before = await app.repo.loadView(tracked.id);
    await router.handle(
      componentInteraction(`sb1:ack:${tracked.id}`, { userId: "9", messageId: statusMessageId }),
    );
    expect(responder.last()).toMatchObject({
      kind: "replyEphemeral",
      data: { content: "You're not a tracked target for this message." },
    });
    expect(await app.repo.loadView(tracked.id)).toEqual(before);
    expect(app.discord.count("editCompanion")).toBe(0);
  });

  it("double ack → Undo offered; Undo revokes and re-renders the companion", async () => {
    const { tracked, statusMessageId } = await trackWith([{ id: "1" }]);
    const ack = () =>
      router.handle(
        componentInteraction(`sb1:ack:${tracked.id}`, { userId: "1", messageId: statusMessageId }),
      );
    await ack();
    await ack();
    expect(responder.last()?.kind).toBe("replyEphemeral");
    expect(responder.text()).toMatch(/^You acknowledged at <t:\d+:t>\.$/);
    expect(JSON.stringify(responder.last()?.data?.components)).toContain(`sb1:undo:${tracked.id}`);
    await router.handle(
      componentInteraction(`sb1:undo:${tracked.id}`, { userId: "1", messageId: "eph" }),
    );
    expect(responder.last()).toMatchObject({
      kind: "update",
      data: { content: "Acknowledgement removed." },
    });
    expect(app.discord.count("editCompanion")).toBe(1);
    expect(await app.repo.getAck(tracked.id, "1")).toMatchObject({ revokedAt: expect.any(Number) });
  });

  it("orphan card (unknown tracked id) heals itself: replaced with 'no longer active', no buttons", async () => {
    await router.handle(componentInteraction("sb1:ack:424242", { userId: "1", messageId: "555" }));
    const call = responder.last();
    expect(call?.kind).toBe("update");
    expect(JSON.stringify(call?.data)).toContain("This tracking is no longer active.");
    expect(JSON.stringify(call?.data)).not.toContain("sb1:");
  });

  it("button on a message other than the tracked companion → outdated", async () => {
    const { tracked } = await trackWith([{ id: "1" }]);
    await router.handle(
      componentInteraction(`sb1:ack:${tracked.id}`, { userId: "1", messageId: "other" }),
    );
    expect(responder.text()).toBe("This control is outdated.");
  });

  it("stopped tracking → ended", async () => {
    const { tracked, statusMessageId } = await trackWith([{ id: "1" }]);
    await app.service.stop(tracked.id, "manual", AUTHOR);
    await router.handle(
      componentInteraction(`sb1:ack:${tracked.id}`, { userId: "1", messageId: statusMessageId }),
    );
    expect(responder.text()).toBe("Tracking for this message has ended.");
  });
});

describe("manage panel", () => {
  it("non-manager is denied", async () => {
    const { tracked, statusMessageId } = await trackWith([{ id: "1" }]);
    await router.handle(
      componentInteraction(`sb1:manage:${tracked.id}`, { userId: "1", messageId: statusMessageId }),
    );
    expect(responder.text()).toBe(
      "Only the person who started tracking or a moderator can manage it.",
    );
  });

  it("moderator: panel pre-filled with targets; edit targets; empty rejected; stop freezes the card", async () => {
    const { tracked, statusMessageId } = await trackWith([{ id: "1" }, { id: "2" }]);
    const mod = { userId: "50", memberPermissions: PermissionFlagsBits.ManageMessages.toString() };
    await router.handle(
      componentInteraction(`sb1:manage:${tracked.id}`, { ...mod, messageId: statusMessageId }),
    );
    const panel = JSON.stringify(responder.last()?.data?.components);
    expect(panel).toContain(`sb1:targets:${tracked.id}`);
    expect(panel).toContain(`"default_values":[{"id":"1","type":"user"},{"id":"2","type":"user"}]`);
    expect(panel).toContain(`sb1:stop:${tracked.id}`);

    await app.service.acknowledge(tracked.id, "2", T0);
    vi.setSystemTime(T0 + 30 * 60_000);
    await router.handle(
      componentInteraction(`sb1:targets:${tracked.id}`, {
        ...mod,
        values: ["1", "3"],
        resolvedUsers: { "1": {}, "3": {} },
      }),
    );
    expect(responder.text()).toBe("Targets updated · 2 people.");
    expect((await app.repo.listTargets(tracked.id)).map((t) => [t.userId, t.addedAt])).toEqual([
      ["1", T0],
      ["3", T0 + 30 * 60_000],
    ]);
    expect(await app.repo.listAcks(tracked.id)).toEqual([]); // removed user's ack deleted

    await router.handle(
      componentInteraction(`sb1:targets:${tracked.id}`, {
        ...mod,
        values: ["77"],
        resolvedUsers: { "77": { bot: true } },
      }),
    );
    expect(responder.text()).toBe("At least one target is required. Use Stop to end tracking.");

    await router.handle(componentInteraction(`sb1:stop:${tracked.id}`, { ...mod }));
    expect(responder.text()).toBe("Tracking stopped.");
    expect(await app.repo.getTracked(tracked.id)).toMatchObject({
      stopReason: "manual",
      stoppedByUserId: "50",
    });
    const body = JSON.stringify(app.discord.companions.get(statusMessageId)?.body);
    expect(body).toContain("stopped by <@50>");
    expect(body).not.toContain("sb1:ack");
  });

  it("targets/stop re-check the manager on every interaction", async () => {
    const { tracked } = await trackWith([{ id: "1" }]);
    await router.handle(componentInteraction(`sb1:stop:${tracked.id}`, { userId: "1" }));
    expect(responder.text()).toBe(
      "Only the person who started tracking or a moderator can manage it.",
    );
    expect((await app.repo.getTracked(tracked.id))?.stoppedAt).toBeNull();
    await router.handle(
      componentInteraction(`sb1:targets:${tracked.id}`, {
        userId: "1",
        values: ["1"],
        resolvedUsers: { "1": {} },
      }),
    );
    expect(responder.text()).toBe(
      "Only the person who started tracking or a moderator can manage it.",
    );
  });
});

describe("router", () => {
  it("outdated custom ids get an ephemeral notice", async () => {
    await router.handle(componentInteraction("sb0:ack:1"));
    expect(responder.text()).toBe("This control is outdated.");
  });

  it("not accepting (shutdown) → restarting", async () => {
    router.accepting = false;
    await router.handle(componentInteraction("sb1:ack:1"));
    expect(responder.text()).toBe("The bot is restarting. Please try again in a moment.");
  });

  it("handler failure after defer → editReply with unavailable", async () => {
    vi.spyOn(app.service, "checkExisting").mockRejectedValue(new Error("SQLITE_BUSY"));
    const src = source([{ id: "1" }]);
    await router.handle(trackSeenInteraction(src));
    expect(responder.last()).toMatchObject({
      kind: "editReply",
      data: { content: "The bot is temporarily unavailable. Please try again shortly." },
    });
  });

  it("stale button after restart: a new instance handles an old card's ack", async () => {
    const { path, cleanup } = tempDbPath("restart");
    try {
      const a = await createApp({ dbPath: path });
      const ra = makeRouter(a);
      const src = { id: nextId(), authorId: AUTHOR, mentions: [{ id: "1" }] };
      a.discord.addMessage(CHANNEL, src.id, AUTHOR);
      await ra.router.handle(trackSeenInteraction(src));
      const [t] = await a.repo.listActive();
      await a.dispose();

      const b = await createApp({ dbPath: path, discord: a.discord });
      const rb = makeRouter(b);
      await rb.router.handle(
        componentInteraction(`sb1:ack:${t?.id}`, {
          userId: "1",
          messageId: t?.statusMessageId ?? "",
        }),
      );
      expect(rb.responder.last()?.kind).toBe("update");
      expect((await b.repo.listAcks(t?.id ?? 0)).map((x) => x.userId)).toEqual(["1"]);
      await b.dispose();
    } finally {
      cleanup();
    }
  });
});
