import {
  type APIApplicationCommandInteraction,
  type APIChatInputApplicationCommandInteraction,
  type APIInteraction,
  type APIMessageApplicationCommandInteraction,
  type APIMessageComponentInteraction,
  type APIModalSubmitInteraction,
  ApplicationCommandType,
  InteractionType,
} from "@discordjs/core";
import { AUTOTRACK_COMMAND_NAME } from "../commands.ts";
import { decodeCustomId } from "../custom-id.ts";
import { MSG } from "../render/text.ts";
import { handleAck, handleManage, handleStop, handleTargets, handleUndo } from "./buttons.ts";
import { handleAutotrack } from "./config/autotrack.ts";
import {
  handlePolicyComponent,
  handlePolicyOpen,
  handleRenameSubmit,
} from "./config/policy-panel.ts";
import type { InteractionDeps } from "./context.ts";
import type { InteractionRef, ModalData, Responder, ResponseData } from "./responder.ts";
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
  showModal(i: InteractionRef, d: ModalData) {
    return this.ack(this.inner.showModal(i, d));
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
          i.type === InteractionType.MessageComponent ||
          i.type === InteractionType.ModalSubmit
        )
          await responder.replyEphemeral(ref, { content: MSG.restarting });
        return;
      }
      if (i.type === InteractionType.ApplicationCommand) {
        const cmd = i as APIApplicationCommandInteraction;
        if (
          cmd.data.type === ApplicationCommandType.Message &&
          cmd.data.name === TRACK_SEEN_COMMAND_NAME
        ) {
          await handleTrackSeen(deps, cmd as APIMessageApplicationCommandInteraction);
        } else if (
          cmd.data.type === ApplicationCommandType.ChatInput &&
          cmd.data.name === AUTOTRACK_COMMAND_NAME
        ) {
          await handleAutotrack(deps, i as APIChatInputApplicationCommandInteraction);
        }
        return;
      }
      if (i.type === InteractionType.MessageComponent) {
        await this.handleComponent(deps, i as APIMessageComponentInteraction);
        return;
      }
      if (i.type === InteractionType.ModalSubmit) {
        await this.handleModal(deps, i as APIModalSubmitInteraction);
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
      case "ap-open":
        return handlePolicyOpen(deps, i, id.channelId);
      default:
        return handlePolicyComponent(deps, i, id.action, id.policyId);
    }
  }

  private async handleModal(deps: InteractionDeps, i: APIModalSubmitInteraction): Promise<void> {
    const id = decodeCustomId(i.data.custom_id);
    if (id?.action === "ap-rename-submit") return handleRenameSubmit(deps, i, id.policyId);
    await deps.responder.replyEphemeral({ id: i.id, token: i.token }, { content: MSG.outdated });
  }
}
