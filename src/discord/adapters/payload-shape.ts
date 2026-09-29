/**
 * SEEN_DEBUG_PAYLOADS diagnostics for the M9 live checklist's ⚠ items (spec §0.2 unverified points):
 * ids and metadata only. Never content, embeds, attachments, names, or snapshot content.
 */

interface MessageShapeInput {
  id: string;
  channel_id: string;
  guild_id?: string;
  channel_type?: number;
  type: number;
  flags?: number;
  author: { id: string; bot?: boolean };
  webhook_id?: string;
  content?: string;
  mentions?: readonly { id: string; bot?: boolean }[];
  mention_roles?: readonly string[];
  mention_everyone?: boolean;
  message_reference?: { type?: number; message_id?: string; channel_id?: string };
  message_snapshots?: readonly {
    message: { mentions?: readonly { id: string }[]; mention_roles?: readonly string[] };
  }[];
}

export function messagePayloadShape(d: MessageShapeInput) {
  const ref = d.message_reference;
  return {
    id: d.id,
    guild_id: d.guild_id ?? null,
    channel_id: d.channel_id,
    channel_type: d.channel_type ?? "missing",
    type: d.type,
    flags: d.flags ?? 0,
    author: { id: d.author.id, bot: d.author.bot ?? false },
    webhook: d.webhook_id !== undefined,
    content_present: typeof d.content === "string" && d.content.length > 0,
    mentions: (d.mentions ?? []).map((m) => ({ id: m.id, bot: m.bot ?? null })),
    mention_roles: [...(d.mention_roles ?? [])],
    mention_everyone: d.mention_everyone ?? null,
    message_reference: ref
      ? {
          type: ref.type ?? null,
          message_id: ref.message_id ?? null,
          channel_id: ref.channel_id ?? null,
        }
      : null,
    snapshots: (d.message_snapshots ?? []).map((s) => ({
      mentions: (s.message.mentions ?? []).map((m) => m.id),
      mention_roles: [...(s.message.mention_roles ?? [])],
    })),
  };
}

export function memberPayloadShape(d: {
  guild_id?: string;
  user?: { id: string; bot?: boolean };
  roles?: readonly string[];
}) {
  return {
    guild_id: d.guild_id ?? null,
    user_id: d.user?.id ?? null,
    bot: d.user?.bot ?? null,
    roles: d.roles ? [...d.roles] : null,
    role_count: d.roles ? d.roles.length : null,
  };
}
