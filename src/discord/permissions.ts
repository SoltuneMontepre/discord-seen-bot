import { ChannelType, PermissionFlagsBits } from "@discordjs/core";

export const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

/** Forum/media posts are PublicThread. Voice/stage text chat is out of MVP scope. */
export const SUPPORTED_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ...THREAD_CHANNEL_TYPES,
]);

const REQUIRED_IN_CHANNEL = {
  VIEW_CHANNEL: PermissionFlagsBits.ViewChannel,
  SEND_MESSAGES: PermissionFlagsBits.SendMessages,
  READ_MESSAGE_HISTORY: PermissionFlagsBits.ReadMessageHistory,
} as const;

const REQUIRED_IN_THREAD = {
  VIEW_CHANNEL: PermissionFlagsBits.ViewChannel,
  SEND_MESSAGES_IN_THREADS: PermissionFlagsBits.SendMessagesInThreads,
  READ_MESSAGE_HISTORY: PermissionFlagsBits.ReadMessageHistory,
} as const;

/** Install permission integer: VIEW_CHANNEL + SEND_MESSAGES + SEND_MESSAGES_IN_THREADS + READ_MESSAGE_HISTORY. */
export const BOT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.ReadMessageHistory;

function has(bits: bigint, flag: bigint): boolean {
  return (bits & flag) === flag;
}

/** Names of required bot permissions missing from the interaction's `app_permissions`. */
export function missingAppPermissions(appPermissions: string, isThread: boolean): string[] {
  const bits = BigInt(appPermissions);
  if (has(bits, PermissionFlagsBits.Administrator)) return [];
  const required = isThread ? REQUIRED_IN_THREAD : REQUIRED_IN_CHANNEL;
  return Object.entries(required)
    .filter(([, flag]) => !has(bits, flag))
    .map(([name]) => name);
}

/** Creator, or a member whose channel-computed permissions include MANAGE_MESSAGES / ADMINISTRATOR. */
export function isManager(
  userId: string,
  creatorUserId: string,
  memberPermissions: string | undefined,
): boolean {
  if (userId === creatorUserId) return true;
  if (!memberPermissions) return false;
  const bits = BigInt(memberPermissions);
  return (
    has(bits, PermissionFlagsBits.ManageMessages) || has(bits, PermissionFlagsBits.Administrator)
  );
}
