import type { Kysely } from "kysely";
import { nextPolicyState } from "../domain/policy-state.ts";
import type { Snowflake, UnixMs } from "../domain/types.ts";
import type { Database } from "./schema.ts";

export interface RoleDeletionResult {
  affectedPolicyIds: number[];
  autoDisabledPolicyIds: number[];
  /** Channels of affected policies that were enabled, i.e. whose live role set changed. */
  affectedChannelIds: Snowflake[];
  /** Active auto trackings that lost a frozen role source. */
  affectedTrackingIds: number[];
}

const SYSTEM = "0";

/**
 * D9: the single role-pruning path, for live GUILD_ROLE_DELETE and for offline pruning at rebuild.
 * Everything happens in one transaction; reconciliation is the caller's job, after commit.
 */
export class RoleDeletionStore {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  async apply(guildId: Snowflake, roleId: Snowflake, at: UnixMs): Promise<RoleDeletionResult> {
    return this.db.transaction().execute(async (trx) => {
      const affected = await trx
        .selectFrom("auto_track_policies as p")
        .innerJoin("auto_track_policy_sources as s", "s.policy_id", "p.id")
        .select(["p.id", "p.channel_id", "p.state"])
        .where("p.guild_id", "=", guildId)
        .where("s.source_type", "=", "role")
        .where("s.source_ref", "=", roleId)
        .orderBy("p.id")
        .execute();
      const policyIds = affected.map((p) => p.id);
      if (policyIds.length > 0) {
        await trx
          .deleteFrom("auto_track_policy_sources")
          .where("policy_id", "in", policyIds)
          .where("source_type", "=", "role")
          .where("source_ref", "=", roleId)
          .execute();
      }

      const autoDisabled: number[] = [];
      const channels = new Set<Snowflake>();
      for (const p of affected) {
        if (p.state === "enabled") channels.add(p.channel_id);
        const left = await trx
          .selectFrom("auto_track_policy_sources")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("policy_id", "=", p.id)
          .executeTakeFirstOrThrow();
        const next = nextPolicyState(p.state, {
          type: "role_deleted",
          sourceCount: Number(left.n),
        });
        if (!next.ok || next.state === p.state) continue;
        await trx
          .updateTable("auto_track_policies")
          .set({
            state: next.state,
            state_changed_at: at,
            state_changed_by: SYSTEM,
            updated_at: at,
            updated_by_user_id: SYSTEM,
          })
          .where("id", "=", p.id)
          .execute();
        if (next.state === "auto_disabled_missing_role") autoDisabled.push(p.id);
      }

      const tracked = await trx
        .deleteFrom("tracking_sources")
        .where("source_type", "=", "role")
        .where("source_ref", "=", roleId)
        .where("tracked_message_id", "in", (eb) =>
          eb
            .selectFrom("tracked_messages")
            .select("id")
            .where("guild_id", "=", guildId)
            .where("stopped_at", "is", null)
            .where("origin", "=", "auto"),
        )
        .returning("tracked_message_id")
        .execute();

      return {
        affectedPolicyIds: policyIds,
        autoDisabledPolicyIds: autoDisabled,
        affectedChannelIds: [...channels],
        affectedTrackingIds: tracked.map((r) => r.tracked_message_id).sort((a, b) => a - b),
      };
    });
  }
}
