import type { TargetSource } from "../domain/target-sources.ts";
import type { MemberRoleIndex } from "./member-role-index.ts";
import type { ResolveContext, ResolvedTarget, TargetSourceResolver } from "./target-resolution.ts";

/** MentionedRole and ChannelPolicy roles: current members from the in-memory index. */
export class RoleSourceResolver implements TargetSourceResolver {
  readonly type = "role";
  readonly requiresMemberState = true;
  private readonly index: MemberRoleIndex;

  constructor(index: MemberRoleIndex) {
    this.index = index;
  }

  resolve(source: TargetSource, ctx: ResolveContext): ResolvedTarget[] {
    return source.type === "role" ? this.index.membersOf(ctx.guildId, source.roleId) : [];
  }
}
