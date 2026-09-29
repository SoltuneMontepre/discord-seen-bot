import {
  type APIMessageApplicationCommandInteraction,
  type APIMessageComponentInteraction,
  ChannelType,
  PermissionFlagsBits,
} from "@discordjs/core";
import type { InteractionDeps } from "../../src/discord/interactions/context.ts";
import type {
  InteractionRef,
  Responder,
  ResponseData,
} from "../../src/discord/interactions/responder.ts";
import { InteractionRouter } from "../../src/discord/interactions/router.ts";
import type { TestApp } from "./app.ts";
import { snowflakeAt } from "./fake-discord.ts";
import { CHANNEL, GUILD } from "./scenario.ts";

export const APP_ID = "999000000000000001";
export const ALL_BOT_PERMS = (
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.ReadMessageHistory
).toString();

export interface ResponderCall {
  kind: keyof Responder;
  ref: InteractionRef;
  data?: ResponseData;
}

export class FakeResponder implements Responder {
  calls: ResponderCall[] = [];
  failOn: keyof Responder | null = null;

  private rec(kind: keyof Responder, ref: InteractionRef, data?: ResponseData) {
    if (this.failOn === kind) throw new Error(`responder ${kind} failed`);
    this.calls.push(data === undefined ? { kind, ref } : { kind, ref, data });
  }
  async deferEphemeral(ref: InteractionRef) {
    this.rec("deferEphemeral", ref);
  }
  async deferUpdate(ref: InteractionRef) {
    this.rec("deferUpdate", ref);
  }
  async replyEphemeral(ref: InteractionRef, data: ResponseData) {
    this.rec("replyEphemeral", ref, data);
  }
  async update(ref: InteractionRef, data: ResponseData) {
    this.rec("update", ref, data);
  }
  async editReply(ref: InteractionRef, data: ResponseData) {
    this.rec("editReply", ref, data);
  }
  last(): ResponderCall | undefined {
    return this.calls.at(-1);
  }
  text(): string {
    return this.last()?.data?.content ?? "";
  }
}

export function makeRouter(app: TestApp, overrides: Partial<InteractionDeps> = {}) {
  const responder = new FakeResponder();
  const deps: InteractionDeps = {
    service: app.service,
    repo: app.repo,
    scheduler: app.scheduler,
    reconciler: app.reconciler,
    port: app.discord,
    responder,
    applicationId: APP_ID,
    policy: app.policy,
    logger: app.logger,
    debugPayloads: false,
    ...overrides,
  };
  return { router: new InteractionRouter(deps), responder, deps };
}

let seq = 100;
const nextInteractionId = () => snowflakeAt(Date.now(), seq++ % 4000);

interface Base {
  userId?: string;
  memberPermissions?: string;
  channelId?: string;
  channelType?: number;
  parentId?: string;
  appPermissions?: string;
  guildId?: string | null;
}

function base(o: Base) {
  const userId = o.userId ?? "100";
  return {
    id: nextInteractionId(),
    application_id: APP_ID,
    token: `tok-${seq}`,
    version: 1,
    ...(o.guildId === null ? {} : { guild_id: o.guildId ?? GUILD }),
    channel_id: o.channelId ?? CHANNEL,
    channel: {
      id: o.channelId ?? CHANNEL,
      type: o.channelType ?? ChannelType.GuildText,
      ...(o.parentId ? { parent_id: o.parentId } : {}),
    },
    app_permissions: o.appPermissions ?? ALL_BOT_PERMS,
    member: {
      user: { id: userId, username: `u${userId}` },
      permissions: o.memberPermissions ?? PermissionFlagsBits.SendMessages.toString(),
      roles: [],
    },
    authorizing_integration_owners: { "0": GUILD },
    context: 0,
    locale: "en-US",
    entitlements: [],
    attachment_size_limit: 1,
  };
}

export interface TargetMessage {
  id: string;
  authorId: string;
  authorBot?: boolean;
  type?: number;
  mentions?: { id: string; bot?: boolean }[];
}

export function trackSeenInteraction(
  target: TargetMessage,
  o: Base = {},
): APIMessageApplicationCommandInteraction {
  return {
    ...base(o),
    type: 2,
    data: {
      id: "cmd1",
      name: "Track Seen",
      type: 3,
      target_id: target.id,
      resolved: {
        messages: {
          [target.id]: {
            id: target.id,
            channel_id: o.channelId ?? CHANNEL,
            type: target.type ?? 0,
            author: { id: target.authorId, username: "a", bot: target.authorBot ?? false },
            content: "",
            mentions: (target.mentions ?? []).map((m) => ({
              id: m.id,
              username: `u${m.id}`,
              bot: m.bot ?? false,
            })),
          },
        },
      },
    },
  } as unknown as APIMessageApplicationCommandInteraction;
}

export function componentInteraction(
  customId: string,
  o: Base & {
    messageId?: string;
    values?: string[];
    resolvedUsers?: Record<string, { bot?: boolean }>;
  } = {},
): APIMessageComponentInteraction {
  const isSelect = o.values !== undefined;
  return {
    ...base(o),
    type: 3,
    message: { id: o.messageId ?? "0", channel_id: o.channelId ?? CHANNEL },
    data: isSelect
      ? {
          custom_id: customId,
          component_type: 5,
          values: o.values,
          resolved: {
            users: Object.fromEntries(
              Object.entries(o.resolvedUsers ?? {}).map(([id, u]) => [
                id,
                { id, username: `u${id}`, bot: u.bot ?? false },
              ]),
            ),
          },
        }
      : { custom_id: customId, component_type: 2 },
  } as unknown as APIMessageComponentInteraction;
}
