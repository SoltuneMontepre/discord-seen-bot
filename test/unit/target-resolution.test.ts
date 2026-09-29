import { describe, expect, it } from "vitest";
import { ExplicitUserResolver } from "../../src/app/explicit-user-resolver.ts";
import { MemberRoleIndex } from "../../src/app/member-role-index.ts";
import { RoleSourceResolver } from "../../src/app/role-source-resolver.ts";
import {
  type ResolvedTarget,
  TargetResolverRegistry,
  type TargetSourceResolver,
} from "../../src/app/target-resolution.ts";
import type { TargetSource } from "../../src/domain/target-sources.ts";

const ctx = { guildId: "500", sourceAuthorId: "100" };
const user = (userId: string): TargetSource => ({ type: "user", userId });
const role = (roleId: string): TargetSource => ({ type: "role", roleId });

/** Stand-in role resolver for registry-only tests (the real one is tested with the index). */
function fakeRoleResolver(members: Record<string, ResolvedTarget[]>): TargetSourceResolver {
  return {
    type: "role",
    requiresMemberState: true,
    resolve: (s) => (s.type === "role" ? (members[s.roleId] ?? []) : []),
  };
}

function registry(...extra: TargetSourceResolver[]) {
  const r = new TargetResolverRegistry();
  r.register(new ExplicitUserResolver());
  for (const e of extra) r.register(e);
  return r;
}

describe("TargetResolverRegistry + ExplicitUserResolver", () => {
  it("duplicate explicit users → once", () => {
    expect(registry().desiredTargets([user("1"), user("2"), user("1")], ctx)).toEqual(["1", "2"]);
  });

  it("author among explicit users → excluded", () => {
    expect(registry().desiredTargets([user("100"), user("2")], ctx)).toEqual(["2"]);
  });

  it("requiresMemberState: false for only user sources, true when any role source present", () => {
    const r = registry(fakeRoleResolver({}));
    expect(r.requiresMemberState([user("1"), user("2")])).toBe(false);
    expect(r.requiresMemberState([])).toBe(false);
    expect(r.requiresMemberState([user("1"), role("700")])).toBe(true);
  });

  it("unknown source type throws (no resolver registered)", () => {
    expect(() => registry().desiredTargets([role("700")], ctx)).toThrow(/no resolver.*role/);
    expect(() => registry().requiresMemberState([role("700")])).toThrow(/no resolver.*role/);
  });

  it("registering the same type twice throws", () => {
    expect(() => registry(new ExplicitUserResolver())).toThrow(/already registered/);
  });

  it("returns the full set above 100 (no truncation; the limit is the caller's job)", () => {
    const many = Array.from({ length: 250 }, (_, i) => user(String(1000 + i)));
    expect(registry().desiredTargets(many, ctx)).toHaveLength(250);
  });

  it("explicit resolver has no member-state dependency", () => {
    const r: TargetSourceResolver = new ExplicitUserResolver();
    expect(r.requiresMemberState).toBe(false);
    expect(r.resolve(user("7"), { guildId: "500" })).toEqual([{ userId: "7", bot: false }]);
    expect(ExplicitUserResolver.length).toBe(0); // constructor takes no dependencies
  });

  it("bot resolved via a role source is excluded; unverifiable (bot undefined) excluded", () => {
    const r = registry(
      fakeRoleResolver({
        "700": [
          { userId: "1", bot: false },
          { userId: "2", bot: true },
          { userId: "3", bot: undefined },
        ],
      }),
    );
    expect(r.desiredTargets([role("700")], ctx)).toEqual(["1"]);
  });
});

describe("registry with RoleSourceResolver over MemberRoleIndex", () => {
  function withRoles(members: { userId: string; roleIds: string[]; bot?: boolean }[]) {
    const index = new MemberRoleIndex();
    index.setReferencedRoles("500", ["dev", "qa"]);
    index.replaceSnapshot(
      "500",
      members.map((m) => ({ userId: m.userId, roleIds: m.roleIds, bot: m.bot ?? false })),
    );
    return registry(new RoleSourceResolver(index));
  }

  it("one role → its members", () => {
    const r = withRoles([
      { userId: "1", roleIds: ["dev"] },
      { userId: "2", roleIds: ["qa"] },
    ]);
    expect(r.desiredTargets([role("dev")], ctx)).toEqual(["1"]);
  });

  it("two roles → union; same user through two roles → once", () => {
    const r = withRoles([
      { userId: "1", roleIds: ["dev", "qa"] },
      { userId: "2", roleIds: ["qa"] },
    ]);
    expect(r.desiredTargets([role("dev"), role("qa")], ctx).sort()).toEqual(["1", "2"]);
  });

  it("explicit + role overlap → once", () => {
    const r = withRoles([{ userId: "1", roleIds: ["dev"] }]);
    expect(r.desiredTargets([user("1"), role("dev")], ctx)).toEqual(["1"]);
  });

  it("bot in role → excluded; author holding the role → excluded", () => {
    const r = withRoles([
      { userId: "1", roleIds: ["dev"], bot: true },
      { userId: "100", roleIds: ["dev"] },
      { userId: "2", roleIds: ["dev"] },
    ]);
    expect(r.desiredTargets([role("dev")], ctx)).toEqual(["2"]);
  });

  it("role resolver requires member state", () => {
    const r = new RoleSourceResolver(new MemberRoleIndex());
    expect(r.type).toBe("role");
    expect(r.requiresMemberState).toBe(true);
  });
});
