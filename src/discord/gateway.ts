import {
  GatewayDispatchEvents,
  type GatewayDispatchPayload,
  type GatewayInteractionCreateDispatchData,
} from "@discordjs/core";
import { WebSocketShardEvents } from "@discordjs/ws";
import type { GatewayHealth } from "../app/gateway-health.ts";
import type { Logger } from "../app/ports.ts";
import type { Reconciler } from "../app/reconciler.ts";
import type { TrackingService } from "../app/tracking-service.ts";
import type { Signal } from "../domain/signals.ts";
import {
  channelDeleteToSignal,
  guildDeleteToSignal,
  messageDeleteBulkToSignal,
  messageDeleteToSignal,
  threadDeleteToSignal,
  threadUpdateToSignal,
} from "./adapters/lifecycle.ts";
import { messageToSignal } from "./adapters/message.ts";
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

  gateway.on(WebSocketShardEvents.Ready, () => {
    const { readyAt } = deps.health.onReady();
    deps.logger.info({ readyAt }, "gateway ready (fresh session)");
    run("fresh session reconcile", () => deps.reconciler.onFreshSession(readyAt));
  });
  gateway.on(WebSocketShardEvents.Resumed, () => {
    deps.health.onResumed();
    deps.logger.info({}, "gateway resumed; missed events replayed by Discord");
  });
  gateway.on(WebSocketShardEvents.Closed, (code: number) => deps.health.onClosed(code));
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
    const signal = dispatchToSignal(payload);
    if (signal) run(signal.t, () => deps.service.recordSignal(signal));
  });
}
