import {
  type APIMessageComponentInteraction,
  type APIMessageUserSelectInteractionData,
  ButtonStyle,
  ComponentType,
  SelectMenuDefaultValueType,
} from "@discordjs/core";
import { eligibleTargets } from "../../domain/eligibility.ts";
import { timestampOf } from "../../domain/snowflake.ts";
import type { TrackedMessage } from "../../domain/types.ts";
import { encodeCustomId } from "../custom-id.ts";
import { isManager } from "../permissions.ts";
import { buildOrphanBody, discordTime } from "../render/card.ts";
import { MSG } from "../render/text.ts";
import { background, type InteractionDeps, invokerId } from "./context.ts";
import { pickerCandidates } from "./target-picker.ts";

type Component = APIMessageComponentInteraction;

const ephemeral = (
  deps: InteractionDeps,
  i: Component,
  content: string,
  components: unknown[] = [],
) =>
  deps.responder.replyEphemeral(
    { id: i.id, token: i.token },
    { content, components: components as never },
  );

/** Loads the tracked row for a card button; handles orphan / mismatched / stopped cards. */
async function loadForCard(
  deps: InteractionDeps,
  i: Component,
  trackedId: number,
): Promise<TrackedMessage | null> {
  const tracked = await deps.repo.getTracked(trackedId);
  if (!tracked) {
    // Orphan card (crash mid-start or purged row): replace it so it heals on first click.
    await deps.responder.update({ id: i.id, token: i.token }, buildOrphanBody() as never);
    return null;
  }
  if (tracked.statusMessageId !== i.message.id) {
    await ephemeral(deps, i, MSG.outdated);
    return null;
  }
  if (tracked.stoppedAt !== null) {
    await ephemeral(deps, i, MSG.ended);
    background(deps.logger, "re-render frozen card", () => deps.scheduler.renderNow(tracked.id));
    return null;
  }
  return tracked;
}

/** 👀 I've seen this (sb1:ack:<id>). §6.4 */
export async function handleAck(
  deps: InteractionDeps,
  i: Component,
  trackedId: number,
): Promise<void> {
  const userId = invokerId(i);
  if (!userId) return;
  const tracked = await loadForCard(deps, i, trackedId);
  if (!tracked) return;

  const r = await deps.service.acknowledge(trackedId, userId, timestampOf(i.id));
  switch (r.kind) {
    case "not_target":
      return ephemeral(deps, i, MSG.notTarget);
    case "already":
      return ephemeral(
        deps,
        i,
        MSG.alreadyAcked(discordTime(r.ack.acknowledgedAt, tracked.createdAt)),
        [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                custom_id: encodeCustomId({ action: "undo", trackedId }),
                label: "Undo",
              },
            ],
          },
        ],
      );
    case "acknowledged":
      await deps.responder.update({ id: i.id, token: i.token }, r.card.body as never);
      await deps.scheduler.noteRendered(trackedId, r.card.hash);
      return;
    case "stopped":
    case "not_found":
      return ephemeral(deps, i, MSG.ended);
  }
}

/** Undo (sb1:undo:<id>) — button on the ephemeral "already acknowledged" message. §6.5 */
export async function handleUndo(
  deps: InteractionDeps,
  i: Component,
  trackedId: number,
): Promise<void> {
  const userId = invokerId(i);
  if (!userId) return;
  const ref = { id: i.id, token: i.token };
  const tracked = await deps.repo.getTracked(trackedId);
  if (!tracked || tracked.stoppedAt !== null) {
    return deps.responder.update(ref, { content: MSG.ended, components: [] });
  }
  const revoked = await deps.service.undo(trackedId, userId, timestampOf(i.id));
  await deps.responder.update(ref, {
    content: revoked ? MSG.ackRemoved : MSG.undoNotYours,
    components: [],
  });
  if (revoked) await deps.scheduler.renderNow(trackedId);
}

async function requireManager(
  i: Component,
  tracked: TrackedMessage,
  respond: (content: string) => Promise<void>,
): Promise<boolean> {
  const userId = invokerId(i);
  if (userId && isManager(userId, tracked.creatorUserId, i.member?.permissions)) return true;
  await respond(MSG.notManager);
  return false;
}

const stopRow = (trackedId: number) => ({
  type: ComponentType.ActionRow,
  components: [
    {
      type: ComponentType.Button,
      style: ButtonStyle.Danger,
      custom_id: encodeCustomId({ action: "stop", trackedId }),
      label: "Stop tracking",
    },
  ],
});

/**
 * Manage (sb1:manage:<id>): ephemeral panel with target editor and Stop. §6.6
 * Auto trackings (M9 D5) offer Stop only: their targets follow sources.
 */
export async function handleManage(
  deps: InteractionDeps,
  i: Component,
  trackedId: number,
): Promise<void> {
  const tracked = await loadForCard(deps, i, trackedId);
  if (!tracked) return;
  if (!(await requireManager(i, tracked, (c) => ephemeral(deps, i, c)))) return;
  if (tracked.origin === "auto") {
    await ephemeral(deps, i, MSG.manageAutoTitle, [stopRow(trackedId)]);
    return;
  }
  const targets = await deps.repo.listTargets(trackedId);
  await ephemeral(deps, i, MSG.manageTitle, [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.UserSelect,
          custom_id: encodeCustomId({ action: "targets", trackedId }),
          placeholder: "Who needs to acknowledge this?",
          min_values: 1,
          max_values: deps.policy.maxTargets,
          default_values: targets.slice(0, deps.policy.maxTargets).map((t) => ({
            id: t.userId,
            type: SelectMenuDefaultValueType.User,
          })),
        },
      ],
    },
    stopRow(trackedId),
  ]);
}

async function loadActiveForPanel(deps: InteractionDeps, i: Component, trackedId: number) {
  const tracked = await deps.repo.getTracked(trackedId);
  if (!tracked || tracked.stoppedAt !== null) {
    await deps.responder.editReply(
      { id: i.id, token: i.token },
      { content: MSG.ended, components: [] },
    );
    return null;
  }
  return tracked;
}

/** Edit targets (sb1:targets:<id>) from the manage panel. Re-checks the manager on every call. */
export async function handleTargets(
  deps: InteractionDeps,
  i: Component,
  trackedId: number,
): Promise<void> {
  const ref = { id: i.id, token: i.token };
  await deps.responder.deferUpdate(ref);
  const say = (content: string) => deps.responder.editReply(ref, { content, components: [] });
  const tracked = await loadActiveForPanel(deps, i, trackedId);
  if (!tracked) return;
  if (!(await requireManager(i, tracked, say))) return;
  if (tracked.origin === "auto") return say(MSG.autoTargetsFixed);
  const userId = invokerId(i) as string;
  if (!("values" in i.data)) return say(MSG.outdated);

  const { targets } = eligibleTargets(
    pickerCandidates(i.data as APIMessageUserSelectInteractionData),
    tracked.sourceAuthorId,
    deps.policy.maxTargets,
  );
  if (targets.length === 0) return say(MSG.targetsEmpty);

  const { added } = await deps.service.setTargets(trackedId, targets, userId, timestampOf(i.id));
  await say(MSG.targetsUpdated(targets.length));
  background(deps.logger, "target backfill", () =>
    deps.reconciler.backfillTargets(trackedId, added),
  );
  await deps.scheduler.renderNow(trackedId);
}

/** Stop (sb1:stop:<id>) from the manage panel. */
export async function handleStop(
  deps: InteractionDeps,
  i: Component,
  trackedId: number,
): Promise<void> {
  const ref = { id: i.id, token: i.token };
  const tracked = await deps.repo.getTracked(trackedId);
  if (!tracked || tracked.stoppedAt !== null) {
    return deps.responder.update(ref, { content: MSG.ended, components: [] });
  }
  const say = (content: string) => deps.responder.update(ref, { content, components: [] });
  if (!(await requireManager(i, tracked, say))) return;
  await deps.service.stop(trackedId, "manual", invokerId(i) ?? null, timestampOf(i.id));
  await say(MSG.stopped);
  await deps.scheduler.renderNow(trackedId);
}
