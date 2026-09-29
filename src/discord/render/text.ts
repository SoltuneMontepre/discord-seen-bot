import type { EvidenceKind, StopReason } from "../../domain/types.ts";

/** Every user-facing string. Inferred states never claim "seen", "read" or "confirmed". */
export const STATE_HEADINGS = {
  CONFIRMED: "✅ **Confirmed**",
  INTERACTED: "💬 **Interacted**",
  LIKELY: "👁 **Likely seen**",
  UNKNOWN: "○ **No signal**",
} as const;

export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  DIRECT_REPLY: "replied",
  DIRECT_REACTION: "reacted",
  TYPING_AFTER: "typing in channel",
  CHANNEL_MESSAGE_AFTER: "posted in channel",
};

export const CARD_TITLE = "### 👀 Seen status";
export const CARD_FOOTER =
  "-# Only ✅ is an explicit acknowledgement. Other states are inferred from activity.";
export const ACK_BUTTON_LABEL = "I've seen this";
export const ACK_BUTTON_EMOJI = "👀";
export const MANAGE_BUTTON_LABEL = "Manage";
export const ORPHAN_CARD_TEXT = "-# This tracking is no longer active.";
export const AUTO_TRACKED_LABEL = "Auto-tracked";
export const PAUSE_NOTICE =
  "-# ⏸ Auto-track temporarily paused — member state is unavailable. Last known targets are shown.";
/** At most this many user lines per card; the header counts stay complete. */
export const MAX_USER_LINES = 25;
export const overflowLine = (n: number) => `-# +${n} more not shown (counts are complete)`;

export function stopLine(
  reason: StopReason,
  byUserId: string | null,
  at: string,
  opts: { limit?: number } = {},
): string {
  switch (reason) {
    case "manual":
      return `-# Tracking ended · stopped${byUserId ? ` by <@${byUserId}>` : ""} · ${at}`;
    case "expired":
      return `-# Tracking ended · expired · ${at}`;
    case "source_deleted":
      return `-# Original message was deleted · tracking ended ${at}`;
    case "status_deleted":
    case "channel_deleted":
      return `-# Tracking ended · ${at}`;
    case "no_eligible_targets":
      return `-# Tracking ended · no eligible targets remain · ${at}`;
    case "target_limit_exceeded":
      return `-# Tracking ended · too many eligible members${opts.limit === undefined ? "" : ` (limit ${opts.limit})`} · ${at}`;
    case "feature_disabled":
      return `-# Tracking ended · role-based auto-track was turned off · ${at}`;
  }
}

export const MSG = {
  notTarget: "You're not a tracked target for this message.",
  alreadyAcked: (at: string) => `You acknowledged at ${at}.`,
  ackRemoved: "Acknowledgement removed.",
  undoNotYours: "There is no acknowledgement of yours to undo on this message.",
  outdated: "This control is outdated.",
  ended: "Tracking for this message has ended.",
  notManager: "Only the person who started tracking or a moderator can manage it.",
  manageTitle: "Manage tracking — edit who needs to acknowledge, or stop tracking.",
  manageAutoTitle:
    "Manage auto tracking — targets follow the message's mentions and the channel's roles. You can stop tracking.",
  autoTargetsFixed:
    "Targets of an auto-tracked message follow its mentions and channel roles and can't be edited.",
  targetsUpdated: (n: number) => `Targets updated · ${n} ${n === 1 ? "person" : "people"}.`,
  targetsEmpty: "At least one target is required. Use Stop to end tracking.",
  stopped: "Tracking stopped.",
  pickerPrompt: "Nobody eligible was mentioned. Who needs to acknowledge this?",
  pickerNoneEligible:
    "None of the selected users can be targets (bots and the message author are excluded). Pick again:",
  started: (n: number, link: string) =>
    `Tracking ${n} ${n === 1 ? "person" : "people"} · [status card](${link})`,
  alreadyTracked: (link: string) => `This message is already tracked · [status card](${link})`,
  beingSetUp: "Tracking is being set up for this message. Try again in a moment.",
  verifyFailed: "Couldn't check the existing tracking for this message. Please try again shortly.",
  sourceMissing: "The original message no longer exists.",
  channelMissing: "This channel no longer exists.",
  threadUnavailable: "This thread is archived or locked.",
  missingPermissions: (perms: string[]) => `I'm missing permissions here: ${perms.join(", ")}.`,
  unknownError: "Couldn't start tracking. Please try again.",
  unavailable: "The bot is temporarily unavailable. Please try again shortly.",
  restarting: "The bot is restarting. Please try again in a moment.",
  notInGuild: "Track Seen only works in server channels.",
  unsupportedChannel: "Track Seen isn't supported in this kind of channel.",
  cannotTrackBot: "Seen status cards can't be tracked.",
  unsupportedMessage: "This kind of message can't be tracked.",
  truncatedTargets: (n: number) =>
    `Only the first 25 people are tracked (${n} more were left out).`,
} as const;
