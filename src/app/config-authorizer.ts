import type { Snowflake } from "../domain/types.ts";

export type ConfigAction = "policy.create" | "policy.list" | "policy.edit" | "policy.delete";

export interface ConfigActor {
  userId: Snowflake;
  guildId: Snowflake | undefined;
  /** The invoker's permissions in the channel (interaction `member.permissions`). */
  memberPermissions: string | undefined;
}

/**
 * The single configuration authorization boundary (spec §12.4). M9: any member of the guild may
 * configure it; tenant isolation is always enforced. A stricter model changes only this class.
 */
export class ConfigAuthorizer {
  authorize(
    actor: ConfigActor,
    _action: ConfigAction,
    scope: { guildId: Snowflake; channelId?: Snowflake },
  ): { ok: true } | { ok: false; reason: string } {
    if (actor.guildId === undefined || actor.guildId !== scope.guildId) {
      return { ok: false, reason: "different guild" };
    }
    return { ok: true };
  }
}
