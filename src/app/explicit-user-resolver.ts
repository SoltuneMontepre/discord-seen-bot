import type { TargetSource } from "../domain/target-sources.ts";
import type { ResolvedTarget, TargetSourceResolver } from "./target-resolution.ts";

/**
 * ExplicitUser: fixed, never consults member state. Bot ids were already removed when the source
 * was built from the outer message's resolved mentions.
 */
export class ExplicitUserResolver implements TargetSourceResolver {
  readonly type = "user";
  readonly requiresMemberState = false;

  resolve(source: TargetSource): ResolvedTarget[] {
    return source.type === "user" ? [{ userId: source.userId, bot: false }] : [];
  }
}
