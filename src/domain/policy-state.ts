/** Channel auto-track policy lifecycle (spec §7.3). Invariant: state 'enabled' ⇒ ≥1 source. */
export type PolicyState = "enabled" | "user_disabled" | "auto_disabled_missing_role";

export const POLICY_STATES: readonly PolicyState[] = [
  "enabled",
  "user_disabled",
  "auto_disabled_missing_role",
];

export type PolicyEvent =
  | { type: "user_disable" }
  | { type: "keep_disabled" }
  | { type: "user_enable"; sourceCount: number }
  /** The user saved a new role set (Role Select). */
  | { type: "roles_saved"; sourceCount: number }
  /** System pruning after a Discord role deletion. */
  | { type: "role_deleted"; sourceCount: number };

export type PolicyTransition =
  | { ok: true; state: PolicyState }
  | { ok: false; reason: "needs_role" | "invalid" };

/**
 * Pure state machine. Adding roles auto re-enables ONLY a policy that was auto-disabled because its
 * last role was deleted; a user-disabled policy is never silently re-enabled.
 */
export function nextPolicyState(state: PolicyState, event: PolicyEvent): PolicyTransition {
  switch (event.type) {
    case "user_disable":
      return { ok: true, state: "user_disabled" };
    case "keep_disabled":
      return state === "auto_disabled_missing_role"
        ? { ok: true, state: "user_disabled" }
        : { ok: false, reason: "invalid" };
    case "user_enable":
      return event.sourceCount >= 1
        ? { ok: true, state: "enabled" }
        : { ok: false, reason: "needs_role" };
    case "roles_saved":
      if (event.sourceCount < 1) return { ok: false, reason: "needs_role" };
      return state === "auto_disabled_missing_role"
        ? { ok: true, state: "enabled" }
        : { ok: true, state };
    case "role_deleted":
      if (state === "enabled" && event.sourceCount === 0)
        return { ok: true, state: "auto_disabled_missing_role" };
      return { ok: true, state };
  }
}
