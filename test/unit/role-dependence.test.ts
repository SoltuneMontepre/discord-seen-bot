import { describe, expect, it } from "vitest";
import { isRoleDependent, isRoleDependentWhenRolesOff } from "../../src/app/role-dependence.ts";

describe("role-dependence (§14.2)", () => {
  it("roles on: only user sources → false; any role → true; none → false", () => {
    expect(isRoleDependent([{ type: "user", userId: "1" }])).toBe(false);
    expect(isRoleDependent([])).toBe(false);
    expect(
      isRoleDependent([
        { type: "user", userId: "1" },
        { type: "role", roleId: "700" },
      ]),
    ).toBe(true);
  });

  it("roles off: explicit-only targets → false", () => {
    expect(
      isRoleDependentWhenRolesOff(
        [
          { type: "user", userId: "1" },
          { type: "user", userId: "2" },
        ],
        ["1", "2"],
      ),
    ).toBe(false);
  });

  it("roles off: any target not among the user sources → true (policy-derived)", () => {
    expect(isRoleDependentWhenRolesOff([{ type: "user", userId: "1" }], ["1", "9"])).toBe(true);
    expect(isRoleDependentWhenRolesOff([], ["9"])).toBe(true);
  });

  it("roles off: any role source row → true", () => {
    expect(
      isRoleDependentWhenRolesOff(
        [
          { type: "user", userId: "1" },
          { type: "role", roleId: "700" },
        ],
        ["1"],
      ),
    ).toBe(true);
  });

  it("roles off: fewer targets than sources (forget-user removed one) → false", () => {
    expect(
      isRoleDependentWhenRolesOff(
        [
          { type: "user", userId: "1" },
          { type: "user", userId: "2" },
        ],
        ["1"],
      ),
    ).toBe(false);
  });
});
