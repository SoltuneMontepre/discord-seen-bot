import {
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIInteraction,
  ComponentType,
} from "@discordjs/core";
import type { CreateCompanionError } from "../../app/ports.ts";
import type { StartResult } from "../../app/tracking-service.ts";
import type { Snowflake } from "../../domain/types.ts";
import { encodeCustomId } from "../custom-id.ts";
import {
  missingAppPermissions,
  SUPPORTED_CHANNEL_TYPES,
  THREAD_CHANNEL_TYPES,
} from "../permissions.ts";
import { jumpLink } from "../render/card.ts";
import { MSG } from "../render/text.ts";
import { background, type InteractionDeps } from "./context.ts";
import type { InteractionRef, ResponseData } from "./responder.ts";

export interface ChannelContext {
  guildId: Snowflake;
  channelId: Snowflake;
  parentChannelId: Snowflake | null;
  isThread: boolean;
}

/** Validation shared by Track Seen and the picker submit (§6.1 step 2). Returns an error text or context. */
export function validateChannel(i: APIInteraction): { error: string } | { ctx: ChannelContext } {
  if (!i.guild_id || !i.channel) return { error: MSG.notInGuild };
  if (!SUPPORTED_CHANNEL_TYPES.has(i.channel.type)) return { error: MSG.unsupportedChannel };
  const isThread = THREAD_CHANNEL_TYPES.has(i.channel.type);
  const missing = missingAppPermissions(i.app_permissions, isThread);
  if (missing.length > 0) return { error: MSG.missingPermissions(missing) };
  const parentId = (i.channel as { parent_id?: string | null }).parent_id ?? null;
  return {
    ctx: {
      guildId: i.guild_id,
      channelId: i.channel.id,
      parentChannelId: isThread ? parentId : null,
      isThread,
    },
  };
}

export function pickerRow(
  sourceMessageId: Snowflake,
): APIActionRowComponent<APIComponentInMessageActionRow> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.UserSelect,
        custom_id: encodeCustomId({ action: "pick", sourceMessageId }),
        placeholder: "Who needs to acknowledge this?",
        min_values: 1,
        max_values: 25,
      },
    ],
  };
}

export function createErrorText(e: CreateCompanionError): string {
  switch (e.kind) {
    case "SourceMissing":
      return MSG.sourceMissing;
    case "MissingPermissions":
      return MSG.missingPermissions(e.permissions);
    case "ChannelMissing":
      return MSG.channelMissing;
    case "ThreadUnavailable":
      return MSG.threadUnavailable;
    case "Unknown":
      return MSG.unknownError;
  }
}

/** Text for an existing-tracking check result (never builds a link from a NULL id). */
export function existingText(
  r:
    | { kind: "already"; tracked: { guildId: string; channelId: string }; statusMessageId: string }
    | { kind: "being_set_up" }
    | { kind: "verify_failed" },
): string {
  if (r.kind === "already")
    return MSG.alreadyTracked(jumpLink(r.tracked.guildId, r.tracked.channelId, r.statusMessageId));
  return r.kind === "being_set_up" ? MSG.beingSetUp : MSG.verifyFailed;
}

/**
 * Responds to the invoking user as soon as the companion exists, then runs the (paginated) initial
 * backfill in the background — never on the interaction latency path.
 */
export async function respondToStart(
  deps: InteractionDeps,
  ref: InteractionRef,
  result: StartResult,
  send: (i: InteractionRef, data: ResponseData) => Promise<void>,
  truncatedCount: number,
): Promise<void> {
  switch (result.kind) {
    case "started": {
      const link = jumpLink(
        result.tracked.guildId,
        result.tracked.channelId,
        result.statusMessageId,
      );
      const targets = await deps.repo.listTargets(result.tracked.id);
      const lines = [MSG.started(targets.length, link)];
      if (truncatedCount > 0) lines.push(MSG.truncatedTargets(truncatedCount));
      await send(ref, { content: lines.join("\n"), components: [] });
      const id = result.tracked.id;
      background(deps.logger, "initial backfill", () => deps.reconciler.initialBackfill(id));
      return;
    }
    case "already":
    case "being_set_up":
    case "verify_failed":
      await send(ref, { content: existingText(result), components: [] });
      return;
    case "create_failed":
      deps.logger.warn({ error: result.error }, "companion creation failed; rolled back");
      await send(ref, { content: createErrorText(result.error), components: [] });
      return;
  }
}
