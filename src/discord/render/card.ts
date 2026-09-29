import { createHash } from "node:crypto";
import {
  type APIComponentInContainer,
  type APIContainerComponent,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
} from "@discordjs/core";
import type { CardRenderer, CardView, CompanionBody, RenderedCard } from "../../app/ports.ts";
import {
  type ProjectionRow,
  STATE_ORDER,
  type TrackedMessage,
  type UnixMs,
} from "../../domain/types.ts";
import { encodeCustomId } from "../custom-id.ts";
import {
  ACK_BUTTON_EMOJI,
  ACK_BUTTON_LABEL,
  AUTO_TRACKED_LABEL,
  CARD_FOOTER,
  CARD_TITLE,
  EVIDENCE_LABELS,
  MANAGE_BUTTON_LABEL,
  MAX_USER_LINES,
  ORPHAN_CARD_TEXT,
  overflowLine,
  PAUSE_NOTICE,
  STATE_HEADINGS,
  stopLine,
} from "./text.ts";

const DAY = 86_400_000;

export function jumpLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Discord timestamp markup; short time, or full date-time when > 24h after tracking started. */
export function discordTime(at: UnixMs, trackingStartedAt: UnixMs): string {
  const style = at - trackingStartedAt > DAY ? "f" : "t";
  return `<t:${Math.floor(at / 1000)}:${style}>`;
}

/** One user row. A time is rendered only when the basis has a real occurrence time. */
export function userRow(row: ProjectionRow, trackingStartedAt: UnixMs): string {
  const mention = `<@${row.userId}>`;
  if (!row.basis) return mention;
  const parts = [mention];
  if (row.basis.kind !== "EXPLICIT_ACK") parts.push(EVIDENCE_LABELS[row.basis.kind]);
  if (row.basis.occurredAt !== null)
    parts.push(discordTime(row.basis.occurredAt, trackingStartedAt));
  return parts.join(" · ");
}

function text(content: string): APIComponentInContainer {
  return { type: ComponentType.TextDisplay, content };
}

function separator(): APIComponentInContainer {
  return { type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small };
}

function header(t: TrackedMessage, rows: ProjectionRow[]): string {
  const confirmed = rows.filter((r) => r.state === "CONFIRMED").length;
  const link =
    t.stopReason === "source_deleted"
      ? "Tracked message (deleted)"
      : `[Tracked message](${jumpLink(t.guildId, t.channelId, t.sourceMessageId)})`;
  const label = t.origin === "auto" ? `${AUTO_TRACKED_LABEL} · ` : "";
  return `${CARD_TITLE}\n-# ${label}${link} · ${confirmed}/${rows.length} confirmed`;
}

export function buildCardBody(view: CardView): CompanionBody {
  const { tracked: t, rows } = view;
  const children: APIComponentInContainer[] = [text(header(t, rows)), separator()];

  let budget = MAX_USER_LINES;
  for (const state of STATE_ORDER) {
    const group = rows.filter((r) => r.state === state).slice(0, budget);
    if (group.length === 0) continue;
    budget -= group.length;
    const lines = group.map((r) => userRow(r, t.createdAt));
    children.push(text([STATE_HEADINGS[state], ...lines].join("\n")));
  }
  if (rows.length > MAX_USER_LINES) children.push(text(overflowLine(rows.length - MAX_USER_LINES)));
  if (view.autoTrackPaused) children.push(text(PAUSE_NOTICE));

  children.push(separator(), text(CARD_FOOTER));

  if (t.stoppedAt !== null && t.stopReason !== null) {
    const opts = view.maxTargets === undefined ? {} : { limit: view.maxTargets };
    children.push(
      text(stopLine(t.stopReason, t.stoppedByUserId, discordTime(t.stoppedAt, 0), opts)),
    );
  } else {
    children.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Success,
          custom_id: encodeCustomId({ action: "ack", trackedId: t.id }),
          label: ACK_BUTTON_LABEL,
          emoji: { name: ACK_BUTTON_EMOJI },
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          custom_id: encodeCustomId({ action: "manage", trackedId: t.id }),
          label: MANAGE_BUTTON_LABEL,
        },
      ],
    });
  }

  const container: APIContainerComponent = { type: ComponentType.Container, components: children };
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowed_mentions: { parse: [] },
  };
}

/** Replacement for a card whose tracking row no longer exists (e.g. orphan from a crash mid-start). */
export function buildOrphanBody(): CompanionBody {
  const container: APIContainerComponent = {
    type: ComponentType.Container,
    components: [text(ORPHAN_CARD_TEXT)],
  };
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowed_mentions: { parse: [] },
  };
}

export function hashBody(body: CompanionBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export const cardRenderer: CardRenderer = {
  render(view: CardView): RenderedCard {
    const body = buildCardBody(view);
    return { body, hash: hashBody(body) };
  },
};

/** Counts every component (including nested) — Discord caps V2 messages at 40. */
export function countComponents(components: readonly unknown[]): number {
  let n = 0;
  for (const c of components) {
    n += 1;
    const nested = (c as { components?: unknown[] }).components;
    if (Array.isArray(nested)) n += countComponents(nested);
  }
  return n;
}
