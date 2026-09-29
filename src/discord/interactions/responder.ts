import type {
  API,
  APIInteractionResponseCallbackData,
  APIModalInteractionResponseCallbackData,
} from "@discordjs/core";
import { MessageFlags } from "@discordjs/core";

export type ResponseData = APIInteractionResponseCallbackData;
export type ModalData = APIModalInteractionResponseCallbackData;

export interface InteractionRef {
  id: string;
  token: string;
}

/** Interaction callback operations used by handlers (fakeable in tests). */
export interface Responder {
  /** DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (5), ephemeral. */
  deferEphemeral(i: InteractionRef): Promise<void>;
  /** DEFERRED_UPDATE_MESSAGE (6) for components. */
  deferUpdate(i: InteractionRef): Promise<void>;
  /** CHANNEL_MESSAGE_WITH_SOURCE (4), ephemeral. */
  replyEphemeral(i: InteractionRef, data: ResponseData): Promise<void>;
  /** UPDATE_MESSAGE (7): edit the message the component is attached to. */
  update(i: InteractionRef, data: ResponseData): Promise<void>;
  /** PATCH the original response (or the component's message after a deferred update). */
  editReply(i: InteractionRef, data: ResponseData): Promise<void>;
  /** MODAL (9). */
  showModal(i: InteractionRef, data: ModalData): Promise<void>;
}

export class CoreResponder implements Responder {
  private readonly api: API;
  private readonly applicationId: string;

  constructor(api: API, applicationId: string) {
    this.api = api;
    this.applicationId = applicationId;
  }

  async deferEphemeral(i: InteractionRef): Promise<void> {
    await this.api.interactions.defer(i.id, i.token, { flags: MessageFlags.Ephemeral });
  }

  async deferUpdate(i: InteractionRef): Promise<void> {
    await this.api.interactions.deferMessageUpdate(i.id, i.token);
  }

  async replyEphemeral(i: InteractionRef, data: ResponseData): Promise<void> {
    await this.api.interactions.reply(i.id, i.token, {
      ...data,
      flags: (data.flags ?? 0) | MessageFlags.Ephemeral,
      allowed_mentions: { parse: [] },
    });
  }

  async update(i: InteractionRef, data: ResponseData): Promise<void> {
    await this.api.interactions.updateMessage(i.id, i.token, {
      allowed_mentions: { parse: [] },
      ...data,
    });
  }

  async editReply(i: InteractionRef, data: ResponseData): Promise<void> {
    await this.api.interactions.editReply(this.applicationId, i.token, {
      allowed_mentions: { parse: [] },
      ...data,
    } as Parameters<API["interactions"]["editReply"]>[2]);
  }

  async showModal(i: InteractionRef, data: ModalData): Promise<void> {
    await this.api.interactions.createModal(i.id, i.token, data);
  }
}
