import type { TargetSource } from "../domain/target-sources.ts";
import type { Snowflake } from "../domain/types.ts";

/**
 * Spec §14.2 — the only definition of role-dependence.
 *
 * ROLE flag on (pause gate, pause notice, reconcile gating): `sources` are the tracking's effective
 * sources (TargetReconciler.sourcesFor), so a live channel-policy role counts as well.
 */
export function isRoleDependent(sources: readonly TargetSource[]): boolean {
  return sources.some((s) => s.type === "role");
}

/**
 * ROLE flag off (D6 startup sweep): any stored role source, or any current target that no stored
 * user source explains (it could only have been qualified by a role).
 */
export function isRoleDependentWhenRolesOff(
  trackingSources: readonly TargetSource[],
  targetUserIds: readonly Snowflake[],
): boolean {
  if (trackingSources.some((s) => s.type === "role")) return true;
  const explicit = new Set(trackingSources.flatMap((s) => (s.type === "user" ? [s.userId] : [])));
  return targetUserIds.some((u) => !explicit.has(u));
}
