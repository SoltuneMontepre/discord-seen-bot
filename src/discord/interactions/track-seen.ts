import { type APIMessageApplicationCommandInteraction, MessageType } from "@discordjs/core";
import { eligibleTargets } from "../../domain/eligibility.ts";
import { timestampOf } from "../../domain/snowflake.ts";
import { MSG } from "../render/text.ts";
import { type InteractionDeps, invokerId } from "./context.ts";
import { existingText, pickerRow, respondToStart, validateChannel } from "./start-flow.ts";

export const TRACK_SEEN_COMMAND_NAME = "Track Seen";

/** Apps → Track Seen (message context menu). §6.1 */
export async function handleTrackSeen(
  deps: InteractionDeps,
  i: APIMessageApplicationCommandInteraction,
): Promise<void> {
  const ref = { id: i.id, token: i.token };
  await deps.responder.deferEphemeral(ref);
  const say = (content: string) => deps.responder.editReply(ref, { content });

  const v = validateChannel(i);
  if ("error" in v) return say(v.error);
  const userId = invokerId(i);
  const target = i.data.resolved.messages[i.data.target_id];
  if (!userId || !target) return say(MSG.unsupportedMessage);
  if (target.author.id === deps.applicationId) return say(MSG.cannotTrackBot);
  if (target.type !== MessageType.Default && target.type !== MessageType.Reply)
    return say(MSG.unsupportedMessage);

  if (deps.debugPayloads) {
    deps.logger.info(
      {
        mentionIds: (target.mentions ?? []).map((u) => u.id),
        hasMentionsField: "mentions" in target,
      },
      "debug: Track Seen resolved mentions (ids only)",
    );
  }

  const existing = await deps.service.checkExisting(target.id);
  if (existing.kind !== "none") return say(existingText(existing));

  const { targets, dropped } = eligibleTargets(
    (target.mentions ?? []).map((u) => ({ id: u.id, bot: u.bot === true })),
    target.author.id,
    deps.policy.maxTargets,
  );
  if (targets.length === 0) {
    await deps.responder.editReply(ref, {
      content: MSG.pickerPrompt,
      components: [pickerRow(target.id)],
    });
    return;
  }

  const result = await deps.service.startTracking({
    ...v.ctx,
    sourceMessageId: target.id,
    sourceAuthorId: target.author.id,
    sourceCreatedAt: timestampOf(target.id),
    creatorUserId: userId,
    targets,
  });
  const truncated = dropped.filter((d) => d.reason === "over_cap").length;
  await respondToStart(
    deps,
    ref,
    result,
    (r, data) => deps.responder.editReply(r, data),
    truncated,
  );
}
