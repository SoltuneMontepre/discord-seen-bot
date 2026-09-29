import { eligibleTargets } from "../domain/eligibility.ts";
import type { TargetSource, TargetSourceType } from "../domain/target-sources.ts";
import type { Snowflake } from "../domain/types.ts";

export interface ResolveContext {
  guildId: Snowflake;
}

export interface ResolvedTarget {
  userId: Snowflake;
  /** undefined = cannot be verified; such users are never targeted. */
  bot: boolean | undefined;
}

export interface TargetSourceResolver {
  readonly type: TargetSourceType;
  /** true when resolving needs the in-memory member-role state (and so pauses with it). */
  readonly requiresMemberState: boolean;
  resolve(source: TargetSource, ctx: ResolveContext): ResolvedTarget[];
}

/** Target sources → desired target set (spec §5–6): union, dedupe, drop author and bots. */
export class TargetResolverRegistry {
  private readonly resolvers = new Map<TargetSourceType, TargetSourceResolver>();

  register(r: TargetSourceResolver): void {
    if (this.resolvers.has(r.type)) throw new Error(`resolver already registered for ${r.type}`);
    this.resolvers.set(r.type, r);
  }

  requiresMemberState(sources: readonly TargetSource[]): boolean {
    return sources.some((s) => this.resolverFor(s).requiresMemberState);
  }

  /** Never truncates: the D8 limit is checked by the caller on the full set. */
  desiredTargets(
    sources: readonly TargetSource[],
    ctx: ResolveContext & { sourceAuthorId: Snowflake },
  ): Snowflake[] {
    const candidates = sources.flatMap((s) =>
      this.resolverFor(s)
        .resolve(s, ctx)
        .map((t) => ({ id: t.userId, bot: t.bot })),
    );
    return eligibleTargets(candidates, ctx.sourceAuthorId, Number.POSITIVE_INFINITY).targets;
  }

  private resolverFor(s: TargetSource): TargetSourceResolver {
    const r = this.resolvers.get(s.type);
    if (!r) throw new Error(`no resolver registered for source type ${s.type}`);
    return r;
  }
}
