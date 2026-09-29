import { describe, expect, it } from "vitest";
import { MemberRoleIndex } from "../../src/app/member-role-index.ts";

const G = "500";
const ids = (xs: { userId: string }[]) => xs.map((x) => x.userId).sort();

function indexWith(roles: string[]) {
  const idx = new MemberRoleIndex();
  idx.setReferencedRoles(G, roles);
  return idx;
}

describe("MemberRoleIndex", () => {
  it("snapshot keeps only members holding referenced roles, and only those roles", () => {
    const idx = indexWith(["700"]);
    idx.replaceSnapshot(G, [
      { userId: "1", roleIds: ["700", "999"], bot: false },
      { userId: "2", roleIds: ["999"], bot: false },
      { userId: "3", roleIds: [], bot: false },
    ]);
    expect(idx.membersOf(G, "700")).toEqual([{ userId: "1", bot: false }]);
    expect(idx.membersOf(G, "999")).toEqual([]);
    expect(idx.memberCount(G)).toBe(1); // privacy: no directory of unrelated members
  });

  it("replaceSnapshot replaces previous membership", () => {
    const idx = indexWith(["700"]);
    idx.replaceSnapshot(G, [{ userId: "1", roleIds: ["700"], bot: false }]);
    idx.replaceSnapshot(G, [{ userId: "2", roleIds: ["700"], bot: true }]);
    expect(idx.membersOf(G, "700")).toEqual([{ userId: "2", bot: true }]);
  });

  it("upsert returns changedRoleIds only for referenced roles; same roles → []", () => {
    const idx = indexWith(["700", "701"]);
    expect(idx.upsert(G, "1", ["700", "999"], false).changedRoleIds).toEqual(["700"]);
    expect(idx.upsert(G, "1", ["700", "998"], false).changedRoleIds).toEqual([]); // nickname-ish
    expect(idx.upsert(G, "1", ["701"], false).changedRoleIds.sort()).toEqual(["700", "701"]);
    expect(ids(idx.membersOf(G, "701"))).toEqual(["1"]);
    expect(idx.membersOf(G, "700")).toEqual([]);
  });

  it("upsert twice identical → second returns [] (idempotent)", () => {
    const idx = indexWith(["700"]);
    idx.upsert(G, "1", ["700"], false);
    expect(idx.upsert(G, "1", ["700"], false).changedRoleIds).toEqual([]);
  });

  it("upsert to no referenced roles deletes the member from the index", () => {
    const idx = indexWith(["700"]);
    idx.upsert(G, "1", ["700"], false);
    expect(idx.upsert(G, "1", ["999"], false).changedRoleIds).toEqual(["700"]);
    expect(idx.memberCount(G)).toBe(0);
  });

  it("remove returns previous referenced roles", () => {
    const idx = indexWith(["700", "701"]);
    idx.upsert(G, "1", ["700", "701", "999"], false);
    expect(idx.remove(G, "1").hadRoleIds.sort()).toEqual(["700", "701"]);
    expect(idx.remove(G, "1").hadRoleIds).toEqual([]);
    expect(idx.memberCount(G)).toBe(0);
  });

  it("dropRole removes the role from all members and from the referenced set", () => {
    const idx = indexWith(["700", "701"]);
    idx.upsert(G, "1", ["700"], false);
    idx.upsert(G, "2", ["700", "701"], false);
    idx.dropRole(G, "700");
    expect(idx.membersOf(G, "700")).toEqual([]);
    expect(ids(idx.membersOf(G, "701"))).toEqual(["2"]);
    expect([...idx.referencedRoles(G)]).toEqual(["701"]);
    expect(idx.memberCount(G)).toBe(1);
  });

  it("setReferencedRoles shrink discards obsolete membership", () => {
    const idx = indexWith(["old", "keep"]);
    idx.replaceSnapshot(G, [
      { userId: "1", roleIds: ["old"], bot: false },
      { userId: "2", roleIds: ["old", "keep"], bot: false },
    ]);
    const r = idx.setReferencedRoles(G, ["keep"]);
    expect(r).toEqual({ droppedRoleIds: ["old"], addedRoleIds: [] });
    expect(idx.membersOf(G, "old")).toEqual([]);
    expect(ids(idx.membersOf(G, "keep"))).toEqual(["2"]);
    expect(idx.memberCount(G)).toBe(1);
    // a later upsert of the old role does not resurrect it
    expect(idx.upsert(G, "1", ["old"], false).changedRoleIds).toEqual([]);
    expect(idx.memberCount(G)).toBe(1);
  });

  it("setReferencedRoles grow adds the role with zero members (no fabricated membership)", () => {
    const idx = indexWith(["700"]);
    idx.upsert(G, "1", ["700"], false);
    const r = idx.setReferencedRoles(G, ["700", "701"]);
    expect(r).toEqual({ droppedRoleIds: [], addedRoleIds: ["701"] });
    expect(idx.membersOf(G, "701")).toEqual([]);
    expect(idx.referencedRoles(G).has("701")).toBe(true);
  });

  it("events applied after replaceSnapshot win", () => {
    const idx = indexWith(["dev"]);
    idx.replaceSnapshot(G, [{ userId: "binh", roleIds: ["dev"], bot: false }]);
    idx.upsert(G, "binh", [], false);
    expect(idx.membersOf(G, "dev")).toEqual([]);
  });

  it("guilds are independent; clear forgets a guild; guildIds lists indexed guilds", () => {
    const idx = indexWith(["700"]);
    idx.setReferencedRoles("501", ["700"]);
    idx.upsert(G, "1", ["700"], false);
    idx.upsert("501", "2", ["700"], false);
    expect(ids(idx.membersOf("501", "700"))).toEqual(["2"]);
    expect([...idx.guildIds()].sort()).toEqual([G, "501"]);
    idx.clear(G);
    expect(idx.membersOf(G, "700")).toEqual([]);
    expect(idx.referencedRoles(G).size).toBe(0);
    expect([...idx.guildIds()]).toEqual(["501"]);
  });

  it("unknown guild: empty referenced set, upsert stores nothing", () => {
    const idx = new MemberRoleIndex();
    expect(idx.referencedRoles("9").size).toBe(0);
    expect(idx.upsert("9", "1", ["700"], false).changedRoleIds).toEqual([]);
    expect(idx.memberCount("9")).toBe(0);
  });
});
