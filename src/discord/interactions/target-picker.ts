import type {
  APIMessageComponentInteraction,
  APIMessageUserSelectInteractionData,
} from "@discordjs/core";
import { eligibleTargets, type TargetCandidate } from "../../domain/eligibility.ts";
import { timestampOf } from "../../domain/snowflake.ts";
import type { Snowflake } from "../../domain/types.ts";
import { MSG } from "../render/text.ts";
import { type InteractionDeps, invokerId } from "./context.ts";
import { existingText, pickerRow, respondToStart, validateChannel } from "./start-flow.ts";

/**
 * Picker values go through the same eligibility rules as mentions. A value without resolved user
 * data cannot be verified (bot flag unknown) and is dropped — never trusted just because Discord
 * supplied it.
 */
export function pickerCandidates(data: APIMessageUserSelectInteractionData): TargetCandidate[] {
  const users = data.resolved?.users ?? {};
  return data.values.map((id) => {
    const u = users[id];
    return { id, bot: u ? u.bot === true : undefined };
  });
}

/** Start picker submit (sb1:pick:<sourceMessageId>). §6.3 */
export async function handlePick(
  deps: InteractionDeps,
  i: APIMessageComponentInteraction,
  sourceMessageId: Snowflake,
): Promise<void> {
  const ref = { id: i.id, token: i.token };
  await deps.responder.deferUpdate(ref);
  const say = (content: string) => deps.responder.editReply(ref, { content, components: [] });

  const v = validateChannel(i);
  if ("error" in v) return say(v.error);
  const userId = invokerId(i);
  if (!userId || !("values" in i.data)) return say(MSG.outdated);

  const source = await deps.port.getMessage(v.ctx.channelId, sourceMessageId);
  if (!source.ok) return say(source.class === "NotFound" ? MSG.sourceMissing : MSG.unavailable);
  if (source.value.authorId === deps.applicationId) return say(MSG.cannotTrackBot);

  const { targets, dropped } = eligibleTargets(
    pickerCandidates(i.data as APIMessageUserSelectInteractionData),
    source.value.authorId,
    deps.policy.maxTargets,
  );
  if (dropped.length > 0) deps.logger.debug({ dropped }, "picker values dropped by eligibility");
  if (targets.length === 0) {
    await deps.responder.editReply(ref, {
      content: MSG.pickerNoneEligible,
      components: [pickerRow(sourceMessageId)],
    });
    return;
  }

  const existing = await deps.service.checkExisting(sourceMessageId);
  if (existing.kind !== "none") return say(existingText(existing));

  const result = await deps.service.startTracking({
    ...v.ctx,
    sourceMessageId,
    sourceAuthorId: source.value.authorId,
    sourceCreatedAt: timestampOf(sourceMessageId),
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
