import type { API, APIMessage, APIMessageTopLevelComponent } from "@discordjs/core";
import { DiscordAPIError, HTTPError } from "@discordjs/rest";
import type {
  CompanionBody,
  CreateCompanionError,
  DiscordPort,
  EditCompanionResult,
  GuildMemberRoles,
  HistoryMessage,
  Lookup,
  LookupFailureClass,
  SourceMessageInfo,
} from "../app/ports.ts";
import { messageToSignal } from "./adapters/message.ts";
import { apiEmojiOf, emojiKeyOf } from "./adapters/reaction.ts";

// JSON error codes from the official "JSON Error Codes" table.
export const ERR = {
  UNKNOWN_CHANNEL: 10003,
  UNKNOWN_MESSAGE: 10008,
  MISSING_ACCESS: 50001,
  MISSING_PERMISSIONS: 50013,
  INVALID_FORM_BODY: 50035,
  ARCHIVED_THREAD: 50083,
  REPLY_WITHOUT_HISTORY: 160002,
  THREAD_LOCKED: 160005,
} as const;

function apiCode(err: unknown): number | undefined {
  if (err instanceof DiscordAPIError && typeof err.code === "number") return err.code;
  return undefined;
}

function httpStatus(err: unknown): number | undefined {
  if (err instanceof DiscordAPIError || err instanceof HTTPError) return err.status;
  return undefined;
}

/** 50035 whose nested errors point at `message_reference` — the missing-reply-target case. */
function isMissingReferenceFormError(err: unknown): boolean {
  if (!(err instanceof DiscordAPIError) || err.code !== ERR.INVALID_FORM_BODY) return false;
  const raw = err.rawError as { errors?: Record<string, unknown> };
  return raw.errors !== undefined && Object.hasOwn(raw.errors, "message_reference");
}

/**
 * createMessage failure → user-facing classification (§10.1). The exact missing-reference shape is
 * not documented; both candidate shapes map to SourceMissing and the manual probe confirms it.
 */
export function mapCreateCompanionError(
  err: unknown,
  missingFromAppPermissions: string[] = [],
): CreateCompanionError {
  const code = apiCode(err);
  if (code === ERR.UNKNOWN_MESSAGE || isMissingReferenceFormError(err))
    return { kind: "SourceMissing" };
  if (code === ERR.REPLY_WITHOUT_HISTORY)
    return { kind: "MissingPermissions", permissions: ["READ_MESSAGE_HISTORY"] };
  if (code === ERR.MISSING_ACCESS || code === ERR.MISSING_PERMISSIONS)
    return {
      kind: "MissingPermissions",
      permissions:
        missingFromAppPermissions.length > 0
          ? missingFromAppPermissions
          : ["VIEW_CHANNEL", "SEND_MESSAGES"],
    };
  if (code === ERR.UNKNOWN_CHANNEL) return { kind: "ChannelMissing" };
  if (code === ERR.ARCHIVED_THREAD || code === ERR.THREAD_LOCKED)
    return { kind: "ThreadUnavailable" };
  return code === undefined ? { kind: "Unknown" } : { kind: "Unknown", code };
}

export function mapEditError(err: unknown): EditCompanionResult {
  const code = apiCode(err);
  const withCode = <K extends string>(kind: K) =>
    code === undefined ? ({ ok: false, kind } as const) : ({ ok: false, kind, code } as const);
  if (code === ERR.UNKNOWN_MESSAGE) return withCode("MessageMissing");
  if (code === ERR.UNKNOWN_CHANNEL) return withCode("ChannelMissing");
  if (code === ERR.ARCHIVED_THREAD || code === ERR.THREAD_LOCKED) return withCode("ArchivedThread");
  if (code === ERR.MISSING_ACCESS || code === ERR.MISSING_PERMISSIONS) return withCode("Forbidden");
  return withCode("Transient");
}

export function classifyLookupError(err: unknown): LookupFailureClass {
  const code = apiCode(err);
  if (code === ERR.UNKNOWN_MESSAGE) return "NotFound";
  if (
    code === ERR.UNKNOWN_CHANNEL ||
    code === ERR.MISSING_ACCESS ||
    code === ERR.MISSING_PERMISSIONS
  )
    return "Permanent";
  const status = httpStatus(err);
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) return "Permanent";
  return "Transient"; // 5xx, 429 exhaustion, network errors, timeouts
}

function lookupFailure(err: unknown): Lookup<never> {
  const code = apiCode(err) ?? httpStatus(err);
  return code === undefined
    ? { ok: false, class: classifyLookupError(err), error: err }
    : { ok: false, class: classifyLookupError(err), code, error: err };
}

export function toSourceInfo(m: APIMessage): SourceMessageInfo {
  const reactions: SourceMessageInfo["reactions"] = [];
  for (const r of m.reactions ?? []) {
    const emojiKey = emojiKeyOf(r.emoji);
    const apiEmoji = apiEmojiOf(r.emoji);
    if (!emojiKey || !apiEmoji) continue;
    reactions.push({
      emojiKey,
      apiEmoji,
      normal: r.count_details.normal,
      burst: r.count_details.burst,
    });
  }
  return { id: m.id, authorId: m.author.id, reactions };
}

export function toHistoryMessage(m: APIMessage): HistoryMessage {
  const signal = messageToSignal(m, false);
  return { id: m.id, signals: signal ? [signal] : [] };
}

/** DiscordPort over @discordjs/core's REST API (rate limits and retries handled by @discordjs/rest). */
export class CoreDiscordPort implements DiscordPort {
  private readonly api: API;

  constructor(api: API) {
    this.api = api;
  }

  async createCompanion(input: {
    channelId: string;
    sourceMessageId: string;
    nonce: string;
    body: CompanionBody;
  }) {
    try {
      const m = await this.api.channels.createMessage(input.channelId, {
        flags: input.body.flags,
        components: input.body.components as APIMessageTopLevelComponent[],
        allowed_mentions: { parse: [], replied_user: false },
        // fail_if_not_exists: true → if the source vanished, fail instead of posting a non-reply card
        message_reference: { message_id: input.sourceMessageId, fail_if_not_exists: true },
        nonce: input.nonce,
        enforce_nonce: true,
      });
      return { ok: true as const, messageId: m.id };
    } catch (err) {
      return { ok: false as const, error: mapCreateCompanionError(err) };
    }
  }

  async editCompanion(
    channelId: string,
    messageId: string,
    body: CompanionBody,
  ): Promise<EditCompanionResult> {
    try {
      await this.api.channels.editMessage(channelId, messageId, {
        flags: body.flags,
        components: body.components as APIMessageTopLevelComponent[],
        allowed_mentions: { parse: [] },
      });
      return { ok: true };
    } catch (err) {
      return mapEditError(err);
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.api.channels.deleteMessage(channelId, messageId);
  }

  async getMessage(channelId: string, messageId: string): Promise<Lookup<SourceMessageInfo>> {
    try {
      return {
        ok: true,
        value: toSourceInfo(await this.api.channels.getMessage(channelId, messageId)),
      };
    } catch (err) {
      return lookupFailure(err);
    }
  }

  async getMessagesBefore(
    channelId: string,
    before: bigint,
    limit: number,
  ): Promise<Lookup<HistoryMessage[]>> {
    try {
      const page = await this.api.channels.getMessages(channelId, {
        before: before.toString(),
        limit,
      });
      return { ok: true, value: page.map(toHistoryMessage) };
    } catch (err) {
      return lookupFailure(err);
    }
  }

  async getReactionUsers(
    channelId: string,
    messageId: string,
    apiEmoji: string,
    type: 0 | 1,
    after: string | undefined,
    limit: number,
  ): Promise<Lookup<{ id: string; bot: boolean }[]>> {
    try {
      const users = await this.api.channels.getMessageReactions(channelId, messageId, apiEmoji, {
        type,
        limit,
        ...(after ? { after } : {}),
      });
      return { ok: true, value: users.map((u) => ({ id: u.id, bot: u.bot === true })) };
    } catch (err) {
      return lookupFailure(err);
    }
  }

  async listGuildMembers(
    guildId: string,
    after: string | undefined,
    limit: number,
  ): Promise<Lookup<GuildMemberRoles[]>> {
    try {
      const members = await this.api.guilds.getMembers(guildId, {
        limit,
        ...(after ? { after } : {}),
      });
      const value: GuildMemberRoles[] = [];
      for (const m of members) {
        if (!m.user) continue;
        value.push({ userId: m.user.id, roleIds: [...m.roles], bot: m.user.bot === true });
      }
      return { ok: true, value };
    } catch (err) {
      return lookupFailure(err);
    }
  }

  async getGuildRoleIds(guildId: string): Promise<Lookup<string[]>> {
    try {
      const roles = await this.api.guilds.getRoles(guildId);
      return { ok: true, value: roles.map((r) => r.id) };
    } catch (err) {
      return lookupFailure(err);
    }
  }
}
