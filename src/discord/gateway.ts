import {
  GatewayDispatchEvents,
  type GatewayDispatchPayload,
  type GatewayInteractionCreateDispatchData,
} from "@discordjs/core";
import { WebSocketShardEvents } from "@discordjs/ws";
import type { AutoTrackCoordinator } from "../app/auto-track-coordinator.ts";
import type { GatewayHealth } from "../app/gateway-health.ts";
import type { Logger } from "../app/ports.ts";
import type { Reconciler } from "../app/reconciler.ts";
import type { TrackingService } from "../app/tracking-service.ts";
import type { Signal } from "../domain/signals.ts";
import type { MemberStateEvent } from "../domain/target-sources.ts";
import {
  channelDeleteToSignal,
  guildDeleteToSignal,
  messageDeleteBulkToSignal,
  messageDeleteToSignal,
  threadDeleteToSignal,
  threadUpdateToSignal,
} from "./adapters/lifecycle.ts";
import {
  guildCreateToEvent,
  guildDeleteToMemberEvent,
  memberRemoveToEvent,
  memberUpsertToEvent,
  roleDeleteToEvent,
} from "./adapters/member.ts";
import {
  type MessageCreateLike,
  messageToAutoTrackCandidate,
  messageToSignal,
} from "./adapters/message.ts";
import { memberPayloadShape, messagePayloadShape } from "./adapters/payload-shape.ts";
import {
  reactionAddToSignal,
  reactionRemoveAllToSignal,
  reactionRemoveEmojiToSignal,
  reactionRemoveToSignal,
} from "./adapters/reaction.ts";
import { typingToSignal } from "./adapters/typing.ts";
import type { InteractionRouter } from "./interactions/router.ts";

/** The subset of @discordjs/ws WebSocketManager used here (fakeable with an EventEmitter). */
export interface GatewayLike {
  on(event: string, listener: (...args: never[]) => unknown): unknown;
  connect(): Promise<void>;
  destroy(): PromiseLike<void> | void;
}

export interface GatewayDeps {
  health: GatewayHealth;
  reconciler: Pick<Reconciler, "onFreshSession">;
  service: Pick<TrackingService, "recordSignal">;
  router: Pick<InteractionRouter, "handle">;
  logger: Logger;
  /** M9: present when either auto-track flag is on. Member events are wired only with roleTargets. */
  autoTrack?: {
    coordinator: Pick<AutoTrackCoordinator, "onTopLevelMessage" | "onMemberEvent" | "onReady">;
    features: { mentionAutoTrack: boolean; roleTargets: boolean };
  };
  /** Unrecoverable gateway condition (e.g. 4014 disallowed intents). */
  onFatal?: (reason: string) => void;
  /** SEEN_DEBUG_PAYLOADS: log ids-only shapes of M9-relevant dispatches (never content). */
  debugPayloads?: boolean;
}

const MESSAGE_SHAPE_EVENTS = new Set<string>([
  GatewayDispatchEvents.MessageCreate,
  GatewayDispatchEvents.MessageUpdate,
]);
const MEMBER_SHAPE_EVENTS = new Set<string>([
  GatewayDispatchEvents.GuildMemberAdd,
  GatewayDispatchEvents.GuildMemberUpdate,
  GatewayDispatchEvents.GuildMemberRemove,
]);

function logPayloadShape(logger: Logger, p: GatewayDispatchPayload): void {
  if (MESSAGE_SHAPE_EVENTS.has(p.t)) {
    const d = p.d as Parameters<typeof messagePayloadShape>[0];
    if (d.author)
      logger.debug({ event: p.t, shape: messagePayloadShape(d) }, "gateway payload shape");
  } else if (MEMBER_SHAPE_EVENTS.has(p.t)) {
    const d = p.d as Parameters<typeof memberPayloadShape>[0];
    logger.debug({ event: p.t, shape: memberPayloadShape(d) }, "gateway payload shape");
  }
}

/** Close code for a privileged intent the Developer Portal has not enabled (no reconnect). */
export const DISALLOWED_INTENTS_CLOSE_CODE = 4014;
export const DISALLOWED_INTENTS_MESSAGE =
  "Disallowed intents: enable Server Members Intent in the Developer Portal or set ROLE_TARGETS_ENABLED=false";

/** Member/role/guild dispatch → member-state event (role flag on only). */
export function dispatchToMemberEvent(p: GatewayDispatchPayload): MemberStateEvent | null {
  switch (p.t) {
    case GatewayDispatchEvents.GuildMemberAdd:
    case GatewayDispatchEvents.GuildMemberUpdate:
      return memberUpsertToEvent(p.d);
    case GatewayDispatchEvents.GuildMemberRemove:
      return memberRemoveToEvent(p.d);
    case GatewayDispatchEvents.GuildRoleDelete:
      return roleDeleteToEvent(p.d);
    case GatewayDispatchEvents.GuildCreate:
      return guildCreateToEvent(p.d);
    case GatewayDispatchEvents.GuildDelete:
      return guildDeleteToMemberEvent(p.d);
    default:
      return null;
  }
}

/** Pure mapping of a dispatch payload to a signal (or null when irrelevant). */
export function dispatchToSignal(p: GatewayDispatchPayload): Signal | null {
  switch (p.t) {
    case GatewayDispatchEvents.MessageCreate:
      return messageToSignal(p.d, true);
    case GatewayDispatchEvents.TypingStart:
      return typingToSignal(p.d);
    case GatewayDispatchEvents.MessageReactionAdd:
      return reactionAddToSignal(p.d);
    case GatewayDispatchEvents.MessageReactionRemove:
      return reactionRemoveToSignal(p.d);
    case GatewayDispatchEvents.MessageReactionRemoveAll:
      return reactionRemoveAllToSignal(p.d);
    case GatewayDispatchEvents.MessageReactionRemoveEmoji:
      return reactionRemoveEmojiToSignal(p.d);
    case GatewayDispatchEvents.MessageDelete:
      return messageDeleteToSignal(p.d);
    case GatewayDispatchEvents.MessageDeleteBulk:
      return messageDeleteBulkToSignal(p.d);
    case GatewayDispatchEvents.ChannelDelete:
      return channelDeleteToSignal(p.d);
    case GatewayDispatchEvents.ThreadDelete:
      return threadDeleteToSignal(p.d);
    case GatewayDispatchEvents.ThreadUpdate:
      return threadUpdateToSignal(p.d);
    case GatewayDispatchEvents.GuildDelete:
      return guildDeleteToSignal(p.d);
    default:
      return null;
  }
}

/**
 * Wires gateway lifecycle to GatewayHealth and dispatches to adapters / the interaction router.
 * - Ready (fresh session) → health.onReady() then the reconciliation sequence.
 * - Resumed → health only: Discord replayed missed events, so no reconciliation.
 */
export function attachGateway(gateway: GatewayLike, deps: GatewayDeps): void {
  const run = (what: string, work: () => Promise<unknown>) =>
    void work().catch((err: unknown) => deps.logger.error({ err, what }, "gateway handler failed"));

  const auto = deps.autoTrack;
  gateway.on(WebSocketShardEvents.Ready, () => {
    auto?.coordinator.onReady();
    const { readyAt } = deps.health.onReady();
    deps.logger.info({ readyAt }, "gateway ready (fresh session)");
    run("fresh session reconcile", () => deps.reconciler.onFreshSession(readyAt));
  });
  gateway.on(WebSocketShardEvents.Resumed, () => {
    deps.health.onResumed();
    deps.logger.info({}, "gateway resumed; missed events replayed by Discord");
  });
  gateway.on(WebSocketShardEvents.Closed, (code: number) => {
    deps.health.onClosed(code);
    if (code === DISALLOWED_INTENTS_CLOSE_CODE) {
      deps.logger.error({ code }, DISALLOWED_INTENTS_MESSAGE);
      deps.onFatal?.(DISALLOWED_INTENTS_MESSAGE);
    }
  });
  gateway.on(WebSocketShardEvents.HeartbeatComplete, (stats: { ackAt: number }) =>
    deps.health.onHeartbeatAck(stats.ackAt),
  );
  gateway.on(WebSocketShardEvents.Error, (err: Error) =>
    deps.logger.error({ err }, "gateway error"),
  );
  gateway.on(WebSocketShardEvents.Dispatch, (payload: GatewayDispatchPayload) => {
    if (payload.t === GatewayDispatchEvents.InteractionCreate) {
      const interaction = payload.d as GatewayInteractionCreateDispatchData;
      run("interaction", () => deps.router.handle(interaction));
      return;
    }
    if (deps.debugPayloads) logPayloadShape(deps.logger, payload);
    const signal = dispatchToSignal(payload);
    if (signal) run(signal.t, () => deps.service.recordSignal(signal));
    if (!auto) return;
    if (payload.t === GatewayDispatchEvents.MessageCreate) {
      const d = payload.d as MessageCreateLike;
      const candidate = messageToAutoTrackCandidate(d, auto.features);
      if (candidate) {
        run("auto-track", () => auto.coordinator.onTopLevelMessage(candidate));
      } else if (d.guild_id && d.type === 0 && !d.author.bot && d.channel_type === undefined) {
        deps.logger.debug({ messageId: d.id }, "auto-track skipped: channel_type missing");
      }
      return;
    }
    if (!auto.features.roleTargets) return;
    const event = dispatchToMemberEvent(payload);
    if (event) run(event.t, () => auto.coordinator.onMemberEvent(event));
  });
}
