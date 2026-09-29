import type { Kysely, Selectable, Transaction } from "kysely";
import type { PolicyState } from "../domain/policy-state.ts";
import type { Snowflake, UnixMs } from "../domain/types.ts";
import type { AutoTrackPoliciesTable, Database } from "./schema.ts";

type Db = Kysely<Database> | Transaction<Database>;

/** A channel auto-track policy (spec §7.3). Role ids are ordered ascending. */
export interface AutoTrackPolicy {
  id: number;
  guildId: Snowflake;
  channelId: Snowflake;
  name: string;
  state: PolicyState;
  roleIds: Snowflake[];
  stateChangedAt: UnixMs;
  stateChangedBy: Snowflake;
  createdAt: UnixMs;
  createdByUserId: Snowflake;
  updatedAt: UnixMs;
  updatedByUserId: Snowflake;
}

function toPolicy(r: Selectable<AutoTrackPoliciesTable>, roleIds: Snowflake[]): AutoTrackPolicy {
  return {
    id: r.id,
    guildId: r.guild_id,
    channelId: r.channel_id,
    name: r.name,
    state: r.state,
    roleIds,
    stateChangedAt: r.state_changed_at,
    stateChangedBy: r.state_changed_by,
    createdAt: r.created_at,
    createdByUserId: r.created_by_user_id,
    updatedAt: r.updated_at,
    updatedByUserId: r.updated_by_user_id,
  };
}

/** Policy persistence. Role pruning lives in RoleDeletionStore; actor anonymization in forgetUser. */
export class PolicyRepository {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  async create(p: {
    guildId: Snowflake;
    channelId: Snowflake;
    name: string;
    roleIds: readonly Snowflake[];
    actor: Snowflake;
    at: UnixMs;
  }): Promise<AutoTrackPolicy> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("auto_track_policies")
        .values({
          guild_id: p.guildId,
          channel_id: p.channelId,
          name: p.name,
          state: "enabled",
          state_changed_at: p.at,
          state_changed_by: p.actor,
          created_at: p.at,
          created_by_user_id: p.actor,
          updated_at: p.at,
          updated_by_user_id: p.actor,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.insertRoles(trx, row.id, p.roleIds, p.actor, p.at);
      return toPolicy(row, await this.roleIdsOf(trx, row.id));
    });
  }

  async get(id: number): Promise<AutoTrackPolicy | undefined> {
    const r = await this.db
      .selectFrom("auto_track_policies")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return r && toPolicy(r, await this.roleIdsOf(this.db, id));
  }

  async listForChannel(
    channelId: Snowflake,
    page: { offset: number; limit: number },
  ): Promise<AutoTrackPolicy[]> {
    const rows = await this.db
      .selectFrom("auto_track_policies")
      .selectAll()
      .where("channel_id", "=", channelId)
      .orderBy("id")
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    const out: AutoTrackPolicy[] = [];
    for (const r of rows) out.push(toPolicy(r, await this.roleIdsOf(this.db, r.id)));
    return out;
  }

  async countForChannel(channelId: Snowflake): Promise<number> {
    const r = await this.db
      .selectFrom("auto_track_policies")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("channel_id", "=", channelId)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /** Union of role ids of the channel's enabled policies (exact channel id, D4). */
  async enabledRoleIdsForChannel(channelId: Snowflake): Promise<Snowflake[]> {
    const rows = await this.db
      .selectFrom("auto_track_policies as p")
      .innerJoin("auto_track_policy_sources as s", "s.policy_id", "p.id")
      .select("s.source_ref")
      .distinct()
      .where("p.channel_id", "=", channelId)
      .where("p.state", "=", "enabled")
      .where("s.source_type", "=", "role")
      .orderBy("s.source_ref")
      .execute();
    return rows.map((r) => r.source_ref);
  }

  async enabledChannelIdsForRoles(
    guildId: Snowflake,
    roleIds: readonly Snowflake[],
  ): Promise<Snowflake[]> {
    if (roleIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("auto_track_policy_sources as s")
      .innerJoin("auto_track_policies as p", "p.id", "s.policy_id")
      .select("p.channel_id")
      .distinct()
      .where("s.source_type", "=", "role")
      .where("s.source_ref", "in", roleIds)
      .where("p.guild_id", "=", guildId)
      .where("p.state", "=", "enabled")
      .orderBy("p.channel_id")
      .execute();
    return rows.map((r) => r.channel_id);
  }

  /** Distinct roles of the guild's enabled policies. */
  async referencedRoleIds(guildId: Snowflake): Promise<Snowflake[]> {
    const rows = await this.db
      .selectFrom("auto_track_policies as p")
      .innerJoin("auto_track_policy_sources as s", "s.policy_id", "p.id")
      .select("s.source_ref")
      .distinct()
      .where("p.guild_id", "=", guildId)
      .where("p.state", "=", "enabled")
      .where("s.source_type", "=", "role")
      .orderBy("s.source_ref")
      .execute();
    return rows.map((r) => r.source_ref);
  }

  /** Distinct roles of all the guild's policies, whatever their state (offline role pruning). */
  async allRoleIds(guildId: Snowflake): Promise<Snowflake[]> {
    const rows = await this.db
      .selectFrom("auto_track_policies as p")
      .innerJoin("auto_track_policy_sources as s", "s.policy_id", "p.id")
      .select("s.source_ref")
      .distinct()
      .where("p.guild_id", "=", guildId)
      .where("s.source_type", "=", "role")
      .orderBy("s.source_ref")
      .execute();
    return rows.map((r) => r.source_ref);
  }

  /** Replaces the role set and sets the state in one transaction. Kept roles keep their added_*. */
  async saveRolesAndState(
    id: number,
    roleIds: readonly Snowflake[],
    state: PolicyState,
    actor: Snowflake,
    at: UnixMs,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const current = new Set(await this.roleIdsOf(trx, id));
      const next = new Set(roleIds);
      const removed = [...current].filter((r) => !next.has(r));
      if (removed.length > 0) {
        await trx
          .deleteFrom("auto_track_policy_sources")
          .where("policy_id", "=", id)
          .where("source_type", "=", "role")
          .where("source_ref", "in", removed)
          .execute();
      }
      await this.insertRoles(
        trx,
        id,
        [...next].filter((r) => !current.has(r)),
        actor,
        at,
      );
      await this.writeState(trx, id, state, actor, at);
    });
  }

  async setState(id: number, state: PolicyState, actor: Snowflake, at: UnixMs): Promise<void> {
    await this.db.transaction().execute((trx) => this.writeState(trx, id, state, actor, at));
  }

  async rename(id: number, name: string, actor: Snowflake, at: UnixMs): Promise<void> {
    await this.db
      .updateTable("auto_track_policies")
      .set({ name, updated_at: at, updated_by_user_id: actor })
      .where("id", "=", id)
      .execute();
  }

  async delete(id: number): Promise<void> {
    await this.db.deleteFrom("auto_track_policies").where("id", "=", id).execute();
  }

  /** CHANNEL_DELETE lifecycle hook. Sources cascade. */
  async deleteChannelPolicies(channelId: Snowflake): Promise<number> {
    const r = await this.db
      .deleteFrom("auto_track_policies")
      .where("channel_id", "=", channelId)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  /** GUILD_REMOVED lifecycle hook. Sources cascade. */
  async purgeGuild(guildId: Snowflake): Promise<number> {
    const r = await this.db
      .deleteFrom("auto_track_policies")
      .where("guild_id", "=", guildId)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  private async roleIdsOf(db: Db, policyId: number): Promise<Snowflake[]> {
    const rows = await db
      .selectFrom("auto_track_policy_sources")
      .select("source_ref")
      .where("policy_id", "=", policyId)
      .where("source_type", "=", "role")
      .orderBy("source_ref")
      .execute();
    return rows.map((r) => r.source_ref);
  }

  private async insertRoles(
    db: Db,
    policyId: number,
    roleIds: readonly Snowflake[],
    actor: Snowflake,
    at: UnixMs,
  ): Promise<void> {
    if (roleIds.length === 0) return;
    await db
      .insertInto("auto_track_policy_sources")
      .values(
        [...new Set(roleIds)].map((roleId) => ({
          policy_id: policyId,
          source_type: "role",
          source_ref: roleId,
          added_at: at,
          added_by_user_id: actor,
        })),
      )
      .execute();
  }

  /** updated_* always; state_changed_* only when the state actually changes. */
  private async writeState(
    db: Db,
    id: number,
    state: PolicyState,
    actor: Snowflake,
    at: UnixMs,
  ): Promise<void> {
    await db
      .updateTable("auto_track_policies")
      .set({ updated_at: at, updated_by_user_id: actor })
      .where("id", "=", id)
      .execute();
    await db
      .updateTable("auto_track_policies")
      .set({ state, state_changed_at: at, state_changed_by: actor })
      .where("id", "=", id)
      .where("state", "!=", state)
      .execute();
  }
}
