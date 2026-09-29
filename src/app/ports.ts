import type { Signal } from "../domain/signals.ts";
import type { ProjectionRow, Snowflake, TrackedMessage, UnixMs } from "../domain/types.ts";

export interface Clock {
  now(): UnixMs;
}

export const systemClock: Clock = { now: () => Date.now() };

/** pino-compatible subset. */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

// ------------------------------------------------------------------ rendering

export interface CardView {
  tracked: TrackedMessage;
  rows: ProjectionRow[];
}

/** Opaque message body (Components V2) plus a deterministic hash of it. */
export interface RenderedCard {
  body: CompanionBody;
  hash: string;
}

export interface CompanionBody {
  flags: number;
  components: unknown[];
  allowed_mentions: { parse: never[]; replied_user?: boolean };
}

export interface CardRenderer {
  render(view: CardView): RenderedCard;
}

// ------------------------------------------------------------------ Discord REST

export type LookupFailureClass = "NotFound" | "Permanent" | "Transient";

export type Lookup<T> =
  | { ok: true; value: T }
  | { ok: false; class: LookupFailureClass; code?: number; error: unknown };

export type CreateCompanionError =
  | { kind: "SourceMissing" }
  | { kind: "MissingPermissions"; permissions: string[] }
  | { kind: "ChannelMissing" }
  | { kind: "ThreadUnavailable" }
  | { kind: "Unknown"; code?: number };

export type EditCompanionResult =
  | { ok: true }
  | {
      ok: false;
      kind: "MessageMissing" | "ChannelMissing" | "ArchivedThread" | "Forbidden" | "Transient";
      code?: number;
    };

export interface HistoryMessage {
  id: Snowflake;
  signals: Signal[];
}

export interface SourceMessageInfo {
  id: Snowflake;
  authorId: Snowflake;
  /** Emoji keys ("<id or unicode name>") with per-type counts; `apiEmoji` is the REST path form. */
  reactions: { emojiKey: string; apiEmoji: string; normal: number; burst: number }[];
}

/** One guild member as the role index needs it (ids only). */
export interface GuildMemberRoles {
  userId: Snowflake;
  roleIds: Snowflake[];
  bot: boolean;
}

export interface DiscordPort {
  createCompanion(input: {
    channelId: Snowflake;
    sourceMessageId: Snowflake;
    nonce: string;
    body: CompanionBody;
  }): Promise<{ ok: true; messageId: Snowflake } | { ok: false; error: CreateCompanionError }>;
  editCompanion(
    channelId: Snowflake,
    messageId: Snowflake,
    body: CompanionBody,
  ): Promise<EditCompanionResult>;
  deleteMessage(channelId: Snowflake, messageId: Snowflake): Promise<void>;
  getMessage(channelId: Snowflake, messageId: Snowflake): Promise<Lookup<SourceMessageInfo>>;
  /** Up to `limit` messages with id < before. Response order is NOT relied upon. */
  getMessagesBefore(
    channelId: Snowflake,
    before: bigint,
    limit: number,
  ): Promise<Lookup<HistoryMessage[]>>;
  getReactionUsers(
    channelId: Snowflake,
    messageId: Snowflake,
    apiEmoji: string,
    type: 0 | 1,
    after: Snowflake | undefined,
    limit: number,
  ): Promise<Lookup<{ id: Snowflake; bot: boolean }[]>>;
  /** List Guild Members (needs GUILD_MEMBERS): up to `limit` members with user id > `after`. */
  listGuildMembers(
    guildId: Snowflake,
    after: Snowflake | undefined,
    limit: number,
  ): Promise<Lookup<GuildMemberRoles[]>>;
  getGuildRoleIds(guildId: Snowflake): Promise<Lookup<Snowflake[]>>;
}
