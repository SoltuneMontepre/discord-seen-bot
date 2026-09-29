import type {
  CompanionBody,
  CreateCompanionError,
  DiscordPort,
  EditCompanionResult,
  HistoryMessage,
  Lookup,
  SourceMessageInfo,
} from "../../src/app/ports.ts";
import type { Signal } from "../../src/domain/signals.ts";
import { DISCORD_EPOCH } from "../../src/domain/snowflake.ts";

export function snowflakeAt(ms: number, seq = 0): string {
  return (((BigInt(ms) - DISCORD_EPOCH) << 22n) | BigInt(seq)).toString();
}

type Failure = {
  ok: false;
  class: "NotFound" | "Permanent" | "Transient";
  code?: number;
  error: unknown;
};
export const notFound: Failure = {
  ok: false,
  class: "NotFound",
  code: 10008,
  error: new Error("Unknown Message"),
};
export const transient: Failure = {
  ok: false,
  class: "Transient",
  code: 500,
  error: new Error("5xx"),
};
export const permanent: Failure = {
  ok: false,
  class: "Permanent",
  code: 50001,
  error: new Error("Missing Access"),
};

interface StoredMessage {
  id: string;
  authorId: string;
  signals: Signal[];
  reactions: Map<string, { apiEmoji: string; users: Map<0 | 1, { id: string; bot: boolean }[]> }>;
}

/**
 * In-memory Discord model. `getMessagesBefore` follows Discord's documented contract: up to `limit`
 * messages with id < before, the nearest ones, ordered newest → oldest (or shuffled on demand).
 */
export class FakeDiscord implements DiscordPort {
  channels = new Map<string, StoredMessage[]>();
  shufflePages = false;
  private nextMessageSeq = 1;
  calls: { method: string; args: unknown[] }[] = [];

  createResults: ({ ok: true } | { ok: false; error: CreateCompanionError })[] = [];
  createGate: Promise<void> | null = null;
  editResults: EditCompanionResult[] = [];
  getMessageOverrides = new Map<string, Failure>();
  getMessageOnce = new Map<string, Failure[]>();
  historyFailures: Failure[] = [];
  historyHook: ((channelId: string, before: bigint) => Failure | undefined) | null = null;
  maxConcurrentGetMessage = 0;
  private activeGetMessage = 0;
  getMessageDelayMs = 0;
  companions = new Map<
    string,
    { channelId: string; body: CompanionBody; replyTo: string; nonce: string }
  >();

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  addMessage(
    channelId: string,
    id: string,
    authorId: string,
    signals: Signal[] = [],
  ): StoredMessage {
    const list = this.channels.get(channelId) ?? [];
    const m: StoredMessage = { id, authorId, signals, reactions: new Map() };
    list.push(m);
    this.channels.set(channelId, list);
    return m;
  }

  deleteStored(channelId: string, id: string): void {
    const list = this.channels.get(channelId) ?? [];
    this.channels.set(
      channelId,
      list.filter((m) => m.id !== id),
    );
  }

  addReaction(
    channelId: string,
    messageId: string,
    emojiKey: string,
    type: 0 | 1,
    user: { id: string; bot?: boolean },
  ): void {
    const m = this.find(channelId, messageId);
    if (!m) throw new Error(`no message ${messageId}`);
    const r = m.reactions.get(emojiKey) ?? { apiEmoji: emojiKey, users: new Map() };
    const list = r.users.get(type) ?? [];
    list.push({ id: user.id, bot: user.bot ?? false });
    r.users.set(type, list);
    m.reactions.set(emojiKey, r);
  }

  private find(channelId: string, id: string): StoredMessage | undefined {
    return (this.channels.get(channelId) ?? []).find((m) => m.id === id);
  }

  async createCompanion(input: {
    channelId: string;
    sourceMessageId: string;
    nonce: string;
    body: CompanionBody;
  }) {
    this.calls.push({ method: "createCompanion", args: [input] });
    if (this.createGate) await this.createGate;
    const r = this.createResults.shift() ?? { ok: true as const };
    if (!r.ok) return r;
    const messageId = snowflakeAt(Date.now(), 4000 + this.nextMessageSeq++);
    this.companions.set(messageId, {
      channelId: input.channelId,
      body: input.body,
      replyTo: input.sourceMessageId,
      nonce: input.nonce,
    });
    this.addMessage(input.channelId, messageId, "bot");
    return { ok: true as const, messageId };
  }

  async editCompanion(
    channelId: string,
    messageId: string,
    body: CompanionBody,
  ): Promise<EditCompanionResult> {
    this.calls.push({ method: "editCompanion", args: [channelId, messageId, body] });
    const r = this.editResults.shift() ?? { ok: true };
    if (r.ok) {
      const c = this.companions.get(messageId);
      if (c) c.body = body;
    }
    return r;
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    this.calls.push({ method: "deleteMessage", args: [channelId, messageId] });
    this.deleteStored(channelId, messageId);
  }

  async getMessage(channelId: string, messageId: string): Promise<Lookup<SourceMessageInfo>> {
    this.calls.push({ method: "getMessage", args: [channelId, messageId] });
    this.activeGetMessage += 1;
    this.maxConcurrentGetMessage = Math.max(this.maxConcurrentGetMessage, this.activeGetMessage);
    try {
      if (this.getMessageDelayMs > 0)
        await new Promise((r) => setTimeout(r, this.getMessageDelayMs));
      else await Promise.resolve();
      const once = this.getMessageOnce.get(messageId);
      if (once && once.length > 0) return once.shift() as Failure;
      const o = this.getMessageOverrides.get(messageId);
      if (o) return o;
      const m = this.find(channelId, messageId);
      if (!m) return notFound;
      return {
        ok: true,
        value: {
          id: m.id,
          authorId: m.authorId,
          reactions: [...m.reactions.entries()].map(([emojiKey, r]) => ({
            emojiKey,
            apiEmoji: r.apiEmoji,
            normal: r.users.get(0)?.length ?? 0,
            burst: r.users.get(1)?.length ?? 0,
          })),
        },
      };
    } finally {
      this.activeGetMessage -= 1;
    }
  }

  async getMessagesBefore(
    channelId: string,
    before: bigint,
    limit: number,
  ): Promise<Lookup<HistoryMessage[]>> {
    this.calls.push({ method: "getMessagesBefore", args: [channelId, before, limit] });
    const hooked = this.historyHook?.(channelId, before);
    if (hooked) return hooked;
    const f = this.historyFailures.shift();
    if (f) return f;
    const page = (this.channels.get(channelId) ?? [])
      .filter((m) => BigInt(m.id) < before)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1)) // newest → oldest (documented)
      .slice(0, limit)
      .map((m) => ({ id: m.id, signals: m.signals }));
    if (this.shufflePages) {
      for (let i = page.length - 1; i > 0; i--) {
        const j = (i * 7919 + 13) % (i + 1);
        [page[i], page[j]] = [page[j] as HistoryMessage, page[i] as HistoryMessage];
      }
    }
    return { ok: true, value: page };
  }

  async getReactionUsers(
    channelId: string,
    messageId: string,
    apiEmoji: string,
    type: 0 | 1,
    after: string | undefined,
    limit: number,
  ) {
    this.calls.push({
      method: "getReactionUsers",
      args: [channelId, messageId, apiEmoji, type, after, limit],
    });
    const m = this.find(channelId, messageId);
    if (!m) return notFound;
    const users = [...(m.reactions.get(apiEmoji)?.users.get(type) ?? [])].sort((a, b) =>
      BigInt(a.id) < BigInt(b.id) ? -1 : 1,
    );
    const start = after === undefined ? users : users.filter((u) => BigInt(u.id) > BigInt(after));
    return { ok: true as const, value: start.slice(0, limit) };
  }
}
