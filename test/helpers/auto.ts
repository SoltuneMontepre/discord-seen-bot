import {
  type MessageCreateLike,
  messageToAutoTrackCandidate,
} from "../../src/discord/adapters/message.ts";
import type { AutoApp } from "./app.ts";
import { snowflakeAt } from "./fake-discord.ts";
import { AUTHOR, CHANNEL, GUILD } from "./scenario.ts";

let seq = 0;

/** A live top-level MESSAGE_CREATE payload (ids only). Mentioned 3-digit ids 9xx are bots. */
export function message(
  o: {
    users?: string[];
    roles?: string[];
    channelId?: string;
    channelType?: number | undefined;
    author?: string;
    everyone?: boolean;
    id?: string;
  } = {},
): MessageCreateLike {
  seq += 1;
  return {
    id: o.id ?? snowflakeAt(Date.now(), 100 + seq),
    channel_id: o.channelId ?? CHANNEL,
    guild_id: GUILD,
    type: 0,
    ...("channelType" in o
      ? o.channelType === undefined
        ? {}
        : { channel_type: o.channelType }
      : { channel_type: 0 }),
    author: { id: o.author ?? AUTHOR },
    mentions: (o.users ?? []).map((id) => ({ id, bot: /^9\d\d$/.test(id) })),
    mention_roles: o.roles ?? [],
    mention_everyone: o.everyone ?? false,
  };
}

/** Adapter → coordinator, as the gateway does (awaiting both phases). */
export async function post(app: AutoApp, payload: MessageCreateLike) {
  const c = messageToAutoTrackCandidate(payload, app.features);
  if (c) await app.coordinator.onTopLevelMessage(c);
  return c;
}

/** Sets guild roles/members in the fake and runs the GUILD_CREATE rebuild to healthy. */
export async function readyGuild(
  app: AutoApp,
  members: Record<string, string[]>,
  opts: { bots?: string[]; roles?: string[] } = {},
) {
  app.discord.guildRoles.set(GUILD, [GUILD, "700", "701", "702", ...(opts.roles ?? [])]);
  for (const [userId, roleIds] of Object.entries(members)) {
    app.discord.setMember(GUILD, userId, roleIds, opts.bots?.includes(userId) ?? false);
  }
  if (!app.rebuilder) throw new Error("role targets are off");
  app.rebuilder.requestRebuild(GUILD, "guild_create");
  await app.settle(GUILD);
}

export function policy(app: AutoApp, roleIds: string[], channelId = CHANNEL, name = "p") {
  return app.policies.create({ guildId: GUILD, channelId, name, roleIds, actor: "9", at: 0 });
}

export async function autoRows(app: AutoApp) {
  return app.db
    .selectFrom("tracked_messages")
    .selectAll()
    .where("origin", "=", "auto")
    .orderBy("id")
    .execute();
}

export async function targetsOf(app: AutoApp, id: number) {
  return (await app.repo.listTargets(id)).map((t) => t.userId).sort();
}

/** Spins the real event loop until `cond` holds (setImmediate is not faked). */
export async function until(cond: () => boolean, max = 200) {
  for (let i = 0; i < max && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error("condition not reached");
}
