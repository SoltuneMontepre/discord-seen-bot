import {
  type APIInteraction,
  type APIMessageApplicationCommandInteraction,
  type APIMessageComponentInteraction,
  ApplicationCommandType,
  InteractionType,
} from "@discordjs/core";
import { decodeCustomId } from "../custom-id.ts";
import { MSG } from "../render/text.ts";
import { handleAck, handleManage, handleStop, handleTargets, handleUndo } from "./buttons.ts";
import type { InteractionDeps } from "./context.ts";
import type { InteractionRef, Responder, ResponseData } from "./responder.ts";
import { handlePick } from "./target-picker.ts";
import { handleTrackSeen, TRACK_SEEN_COMMAND_NAME } from "./track-seen.ts";

/** Wraps the responder to remember whether the interaction has been acknowledged. */
class TrackingResponder implements Responder {
  acknowledged = false;
  private readonly inner: Responder;

  constructor(inner: Responder) {
    this.inner = inner;
  }

  private async ack<T>(p: Promise<T>): Promise<T> {
    const r = await p;
    this.acknowledged = true;
    return r;
  }

  deferEphemeral(i: InteractionRef) {
    return this.ack(this.inner.deferEphemeral(i));
  }
  deferUpdate(i: InteractionRef) {
    return this.ack(this.inner.deferUpdate(i));
  }
  replyEphemeral(i: InteractionRef, d: ResponseData) {
    return this.ack(this.inner.replyEphemeral(i, d));
  }
  update(i: InteractionRef, d: ResponseData) {
    return this.ack(this.inner.update(i, d));
  }
  editReply(i: InteractionRef, d: ResponseData) {
    return this.inner.editReply(i, d);
  }
}

/** Stateless router: everything is loaded from SQLite per interaction, so buttons survive restarts. */
export class InteractionRouter {
  private readonly deps: InteractionDeps;
  accepting = true;

  constructor(deps: InteractionDeps) {
    this.deps = deps;
  }

  async handle(i: APIInteraction): Promise<void> {
    const responder = new TrackingResponder(this.deps.responder);
    const deps: InteractionDeps = { ...this.deps, responder };
    const ref = { id: i.id, token: i.token };
    try {
      if (!this.accepting) {
        if (
          i.type === InteractionType.ApplicationCommand ||
          i.type === InteractionType.MessageComponent
        )
          await responder.replyEphemeral(ref, { content: MSG.restarting });
        return;
      }
      if (i.type === InteractionType.ApplicationCommand) {
        const cmd = i as APIMessageApplicationCommandInteraction;
        if (
          cmd.data.type === ApplicationCommandType.Message &&
          cmd.data.name === TRACK_SEEN_COMMAND_NAME
        ) {
          await handleTrackSeen(deps, cmd);
        }
        return;
      }
      if (i.type === InteractionType.MessageComponent) {
        await this.handleComponent(deps, i as APIMessageComponentInteraction);
      }
    } catch (err) {
      this.deps.logger.error(
        { err, interactionId: i.id, type: i.type },
        "interaction handler failed",
      );
      try {
        if (responder.acknowledged)
          await responder.editReply(ref, { content: MSG.unavailable, components: [] });
        else await responder.replyEphemeral(ref, { content: MSG.unavailable });
      } catch (err2) {
        this.deps.logger.warn({ err: err2 }, "could not report interaction failure");
      }
    }
  }

  private async handleComponent(
    deps: InteractionDeps,
    i: APIMessageComponentInteraction,
  ): Promise<void> {
    const id = decodeCustomId(i.data.custom_id);
    if (!id) {
      await deps.responder.replyEphemeral({ id: i.id, token: i.token }, { content: MSG.outdated });
      return;
    }
    switch (id.action) {
      case "ack":
        return handleAck(deps, i, id.trackedId);
      case "undo":
        return handleUndo(deps, i, id.trackedId);
      case "manage":
        return handleManage(deps, i, id.trackedId);
      case "targets":
        return handleTargets(deps, i, id.trackedId);
      case "stop":
        return handleStop(deps, i, id.trackedId);
      case "pick":
        return handlePick(deps, i, id.sourceMessageId);
    }
  }
}
