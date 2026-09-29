import type { StartInput } from "../../src/app/tracking-service.ts";
import type { Signal } from "../../src/domain/signals.ts";
import { timestampOf } from "../../src/domain/snowflake.ts";
import type { TestApp } from "./app.ts";
import { snowflakeAt } from "./fake-discord.ts";

export const GUILD = "500";
export const CHANNEL = "600";
export const AUTHOR = "100";

let seq = 1;
export function nextId(ms = Date.now()): string {
  seq += 1;
  return snowflakeAt(ms, seq % 4000);
}

/** Posts a source message into the fake channel and starts tracking it. */
export async function startTracked(
  app: TestApp,
  opts: {
    targets?: string[];
    channelId?: string;
    parentChannelId?: string | null;
    sourceAt?: number;
  } = {},
) {
  const channelId = opts.channelId ?? CHANNEL;
  const sourceId = nextId(opts.sourceAt ?? Date.now() - 60_000);
  app.discord.addMessage(channelId, sourceId, AUTHOR);
  const input: StartInput = {
    guildId: GUILD,
    channelId,
    parentChannelId: opts.parentChannelId ?? null,
    sourceMessageId: sourceId,
    sourceAuthorId: AUTHOR,
    sourceCreatedAt: timestampOf(sourceId),
    creatorUserId: AUTHOR,
    targets: opts.targets ?? ["1", "2"],
  };
  const result = await app.service.startTracking(input);
  if (result.kind !== "started") throw new Error(`start failed: ${result.kind}`);
  return { ...result, input, sourceId };
}

export function msg(
  authorId: string,
  opts: { at?: number; replyTo?: string; channelId?: string; id?: string } = {},
): Extract<Signal, { t: "MESSAGE" }> {
  const at = opts.at ?? Date.now();
  const id = opts.id ?? nextId(at);
  return {
    t: "MESSAGE",
    guildId: GUILD,
    channelId: opts.channelId ?? CHANNEL,
    messageId: id,
    authorId,
    occurredAt: timestampOf(id),
    ...(opts.replyTo ? { replyToMessageId: opts.replyTo } : {}),
  };
}

export function typing(userId: string, at = Date.now(), channelId = CHANNEL): Signal {
  return { t: "TYPING", guildId: GUILD, channelId, userId, occurredAt: at };
}

export function reaction(
  t: "REACTION_ADD" | "REACTION_REMOVE",
  userId: string,
  messageId: string,
  key = "👍|0",
): Signal {
  return { t, guildId: GUILD, channelId: CHANNEL, messageId, userId, reactionKey: key };
}
