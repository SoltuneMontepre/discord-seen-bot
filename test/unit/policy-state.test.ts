import { describe, expect, it } from "vitest";
import {
  nextPolicyState,
  type PolicyEvent,
  type PolicyState,
} from "../../src/domain/policy-state.ts";

describe("nextPolicyState (spec §7.3)", () => {
  it.each<[PolicyState, PolicyEvent, PolicyState]>([
    ["enabled", { type: "user_disable" }, "user_disabled"],
    ["enabled", { type: "role_deleted", sourceCount: 1 }, "enabled"],
    ["enabled", { type: "role_deleted", sourceCount: 0 }, "auto_disabled_missing_role"],
    ["enabled", { type: "roles_saved", sourceCount: 3 }, "enabled"],
    ["auto_disabled_missing_role", { type: "roles_saved", sourceCount: 1 }, "enabled"],
    ["auto_disabled_missing_role", { type: "keep_disabled" }, "user_disabled"],
    ["auto_disabled_missing_role", { type: "user_disable" }, "user_disabled"],
    ["user_disabled", { type: "roles_saved", sourceCount: 2 }, "user_disabled"],
    ["user_disabled", { type: "role_deleted", sourceCount: 0 }, "user_disabled"],
    ["user_disabled", { type: "user_enable", sourceCount: 1 }, "enabled"],
    ["enabled", { type: "user_enable", sourceCount: 1 }, "enabled"],
  ])("%s + %o → %s", (from, event, to) => {
    expect(nextPolicyState(from, event)).toEqual({ ok: true, state: to });
  });

  it("user_enable with zero sources → needs_role", () => {
    expect(nextPolicyState("user_disabled", { type: "user_enable", sourceCount: 0 })).toEqual({
      ok: false,
      reason: "needs_role",
    });
    expect(
      nextPolicyState("auto_disabled_missing_role", { type: "user_enable", sourceCount: 0 }),
    ).toEqual({ ok: false, reason: "needs_role" });
  });

  it("roles_saved with zero sources → needs_role (every state)", () => {
    for (const s of ["enabled", "user_disabled", "auto_disabled_missing_role"] as const) {
      expect(nextPolicyState(s, { type: "roles_saved", sourceCount: 0 })).toEqual({
        ok: false,
        reason: "needs_role",
      });
    }
  });

  it("keep_disabled is only valid from auto_disabled_missing_role", () => {
    expect(nextPolicyState("enabled", { type: "keep_disabled" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(nextPolicyState("user_disabled", { type: "keep_disabled" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("invariant: every ok result with state enabled has sourceCount ≥ 1", () => {
    const states: PolicyState[] = ["enabled", "user_disabled", "auto_disabled_missing_role"];
    const events: PolicyEvent[] = [];
    for (const n of [0, 1, 2]) {
      events.push({ type: "user_enable", sourceCount: n });
      events.push({ type: "roles_saved", sourceCount: n });
      events.push({ type: "role_deleted", sourceCount: n });
    }
    for (const s of states) {
      for (const e of events) {
        const r = nextPolicyState(s, e);
        if (r.ok && r.state === "enabled" && "sourceCount" in e) {
          expect(e.sourceCount).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});
