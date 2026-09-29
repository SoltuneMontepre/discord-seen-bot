import { PermissionFlagsBits } from "@discordjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeCustomId } from "../../src/discord/custom-id.ts";
import type { InteractionDeps } from "../../src/discord/interactions/context.ts";
import { MSG } from "../../src/discord/render/text.ts";
import { type AutoApp, createAutoApp } from "../helpers/app.ts";
import { readyGuild } from "../helpers/auto.ts";
import { T0 } from "../helpers/domain.ts";
import {
  autotrackInteraction,
  componentInteraction,
  type FakeResponder,
  makeRouter,
  modalSubmitInteraction,
  selectInteraction,
} from "../helpers/interactions.ts";
import { CHANNEL, GUILD } from "../helpers/scenario.ts";

let app: AutoApp;
let router: ReturnType<typeof makeRouter>["router"];
let responder: FakeResponder;

async function make(features = { mentionAutoTrack: true, roleTargets: true }, policy = {}) {
  app = await createAutoApp({ features, policy });
  const autotrack: InteractionDeps["autotrack"] = {
    features,
    policies: app.policies,
    ...(app.policyService ? { policyService: app.policyService } : {}),
  };
  ({ router, responder } = makeRouter(app, { autotrack }));
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await app.dispose();
  vi.useRealTimers();
});

const PERMS = (...bits: bigint[]) => bits.reduce((a, b) => a | b, 0n).toString();
const ALL = PERMS(
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
);

function createCmd(
  o: {
    channelId?: string;
    name?: string;
    roleId?: string;
    type?: number;
    appPerms?: string;
    userId?: string;
    memberPermissions?: string;
    invocationPerms?: string;
  } = {},
) {
  const channelId = o.channelId ?? CHANNEL;
  return autotrackInteraction(
    "create",
    [
      { name: "channel", type: 7, value: channelId },
      { name: "name", type: 3, value: o.name ?? "Dev team" },
      { name: "role", type: 8, value: o.roleId ?? "700" },
    ],
    {
      userId: o.userId ?? "42",
      memberPermissions: o.memberPermissions ?? "0",
      ...(o.invocationPerms ? { appPermissions: o.invocationPerms } : {}),
      resolvedChannels: {
        [channelId]: {
          type: o.type ?? 0,
          ...(o.appPerms === undefined ? {} : { app_permissions: o.appPerms }),
        },
      },
    },
  );
}

const listCmd = (opts: { channelId?: string; page?: number } = {}) =>
  autotrackInteraction("list", [
    ...(opts.channelId ? [{ name: "channel", type: 7, value: opts.channelId }] : []),
    ...(opts.page ? [{ name: "page", type: 4, value: opts.page }] : []),
  ]);

const lastJson = () => JSON.stringify(responder.last()?.data ?? {});

async function createdPolicy(roleId = "700", name = "Dev team") {
  await router.handle(createCmd({ roleId, name }));
  const [p] = await app.policies
    .listForChannel(CHANNEL, { offset: 0, limit: 100 })
    .then((ps) => ps.filter((x) => x.name === name));
  if (!p) throw new Error(`not created: ${responder.text()}`);
  return p;
}

describe("/autotrack", () => {
  it("create: deferred ephemeral, then the policy panel", async () => {
    await make();
    await readyGuild(app, { "1": ["700"] });
    await router.handle(createCmd({ appPerms: ALL }));
    expect(responder.calls[0]?.kind).toBe("deferEphemeral");
    expect(responder.last()?.kind).toBe("editReply");
    const [p] = await app.policies.listForChannel(CHANNEL, { offset: 0, limit: 10 });
    if (!p) throw new Error();
    expect(responder.text()).toContain("**Dev team**");
    expect(responder.text()).toContain("Enabled");
    expect(responder.text()).toContain("<@&700>");
    const json = lastJson();
    expect(json).toContain(encodeCustomId({ action: "ap-roles", policyId: p.id }));
    expect(json).toContain('"default_values":[{"id":"700","type":"role"}]');
    expect(json).toContain('"max_values":25');
    expect(json).toContain(encodeCustomId({ action: "ap-disable", policyId: p.id }));
    expect(json).toContain(encodeCustomId({ action: "ap-rename", policyId: p.id }));
    expect(json).toContain(encodeCustomId({ action: "ap-delete", policyId: p.id }));
    expect(responder.text()).not.toMatch(/missing permissions/i);
  });

  it("an ordinary member (no permissions) may configure", async () => {
    await make();
    await readyGuild(app, {});
    await router.handle(createCmd({ memberPermissions: "0" }));
    expect(await app.policies.countForChannel(CHANNEL)).toBe(1);
  });

  it("with role targets off, every /autotrack interaction gets the disabled reply", async () => {
    await make({ mentionAutoTrack: true, roleTargets: false });
    await router.handle(createCmd());
    expect(responder.last()?.kind).toBe("replyEphemeral");
    expect(responder.text()).toBe(MSG.autotrackDisabled);
    await router.handle(listCmd());
    expect(responder.text()).toBe(MSG.autotrackDisabled);
    await router.handle(
      selectInteraction(encodeCustomId({ action: "ap-roles", policyId: 1 }), ["700"]),
    );
    expect(responder.text()).toBe(MSG.autotrackDisabled);
    await router.handle(
      modalSubmitInteraction(encodeCustomId({ action: "ap-rename-submit", policyId: 1 }), {
        name: "x",
      }),
    );
    expect(responder.text()).toBe(MSG.autotrackDisabled);
    expect(await app.policies.countForChannel(CHANNEL)).toBe(0);
  });

  it("over-limit and paused rejections render errors", async () => {
    await make(undefined, { autoTrackMaxTargets: 1 });
    await readyGuild(app, { "1": ["700"], "2": ["700"] });
    await router.handle(createCmd());
    expect(responder.text()).toBe(MSG.policyOverLimit(2, 1));
    app.autoHealth?.set(GUILD, "failed");
    await router.handle(createCmd({ roleId: "701" }));
    expect(responder.text()).toBe(MSG.policyPaused);
    expect(await app.policies.countForChannel(CHANNEL)).toBe(0);
  });

  it("create in a non-text channel is refused", async () => {
    await make();
    await readyGuild(app, {});
    await router.handle(createCmd({ type: 2 }));
    expect(responder.text()).toBe(MSG.policyChannelType);
  });

  it("@everyone is refused", async () => {
    await make();
    await readyGuild(app, {});
    await router.handle(createCmd({ roleId: GUILD }));
    expect(responder.text()).toBe(MSG.policyEveryone);
  });
});

describe("policy panel", () => {
  it("role select saves roles and auto re-enables an auto-disabled policy", async () => {
    await make();
    await readyGuild(app, { "1": ["701"] });
    const p = await createdPolicy();
    await app.coordinator.onMemberEvent({ t: "role_delete", guildId: GUILD, roleId: "700" });
    await router.handle(
      selectInteraction(encodeCustomId({ action: "ap-roles", policyId: p.id }), ["701"]),
    );
    expect(responder.calls.at(-2)?.kind).toBe("deferUpdate");
    expect(await app.policies.get(p.id)).toMatchObject({ state: "enabled", roleIds: ["701"] });
    expect(responder.text()).toContain("Enabled");
  });

  it("auto-disabled panel explains itself and offers Keep disabled", async () => {
    await make();
    await readyGuild(app, {});
    const p = await createdPolicy();
    await app.coordinator.onMemberEvent({ t: "role_delete", guildId: GUILD, roleId: "700" });
    await router.handle(
      componentInteraction(encodeCustomId({ action: "ap-view", policyId: p.id })),
    );
    expect(responder.text()).toContain(
      "Disabled — its last role was deleted. Add a role to re-enable.",
    );
    expect(lastJson()).toContain(encodeCustomId({ action: "ap-keep", policyId: p.id }));
    await router.handle(
      componentInteraction(encodeCustomId({ action: "ap-keep", policyId: p.id })),
    );
    expect((await app.policies.get(p.id))?.state).toBe("user_disabled");
    expect(lastJson()).toContain(encodeCustomId({ action: "ap-enable", policyId: p.id }));
  });

  it("disable / enable buttons", async () => {
    await make();
    await readyGuild(app, {});
    const p = await createdPolicy();
    await router.handle(
      componentInteraction(encodeCustomId({ action: "ap-disable", policyId: p.id })),
    );
    expect((await app.policies.get(p.id))?.state).toBe("user_disabled");
    await router.handle(
      componentInteraction(encodeCustomId({ action: "ap-enable", policyId: p.id })),
    );
    expect((await app.policies.get(p.id))?.state).toBe("enabled");
    await router.handle(
      componentInteraction(encodeCustomId({ action: "ap-keep", policyId: p.id })),
    );
    expect(responder.text()).toContain(MSG.policyInvalidState);
  });

  it("rename opens a modal; submitting renames and refreshes the panel", async () => {
    await make();
    await readyGuild(app, {});
    const p = await createdPolicy();
    await router.handle(
      componentInteraction(encodeCustomId({ action: "ap-rename", policyId: p.id })),
    );
    expect(responder.last()?.kind).toBe("showModal");
    const modal = lastJson();
    expect(modal).toContain(encodeCustomId({ action: "ap-rename-submit", policyId: p.id }));
    expect(modal).toContain('"value":"Dev team"');
    expect(modal).toContain('"max_length":100');
    await router.handle(
      modalSubmitInteraction(encodeCustomId({ action: "ap-rename-submit", policyId: p.id }), {
        name: "Backend",
      }),
    );
    expect((await app.policies.get(p.id))?.name).toBe("Backend");
    expect(responder.text()).toContain("**Backend**");
  });

  it("delete asks for confirmation; cancel returns to the panel; confirm deletes", async () => {
    await make();
    await readyGuild(app, {});
    const p = await createdPolicy();
    await router.handle(
      componentInteraction(encodeCustomId({ action: "ap-delete", policyId: p.id })),
    );
    expect(responder.last()?.kind).toBe("update");
    expect(lastJson()).toContain(encodeCustomId({ action: "ap-delete-confirm", policyId: p.id }));
    expect(lastJson()).toContain(encodeCustomId({ action: "ap-view", policyId: p.id }));
    expect(await app.policies.get(p.id)).toBeDefined();
    await router.handle(
      componentInteraction(encodeCustomId({ action: "ap-view", policyId: p.id })),
    );
    expect(responder.text()).toContain("**Dev team**");
    await router.handle(
      componentInteraction(encodeCustomId({ action: "ap-delete-confirm", policyId: p.id })),
    );
    expect(await app.policies.get(p.id)).toBeUndefined();
    expect(responder.text()).toBe(MSG.policyDeleted);
  });

  it("a forged ap-* custom_id for another guild's policy → outdated, no change", async () => {
    await make();
    const other = await app.policies.create({
      guildId: "501",
      channelId: "700",
      name: "theirs",
      roleIds: ["800"],
      actor: "9",
      at: T0,
    });
    for (const action of [
      "ap-disable",
      "ap-delete-confirm",
      "ap-view",
      "ap-delete",
      "ap-rename",
    ] as const) {
      await router.handle(componentInteraction(encodeCustomId({ action, policyId: other.id })));
      expect(responder.text()).toBe(MSG.outdated);
    }
    await router.handle(
      selectInteraction(encodeCustomId({ action: "ap-roles", policyId: other.id }), ["700"]),
    );
    expect(responder.text()).toBe(MSG.outdated);
    await router.handle(
      modalSubmitInteraction(encodeCustomId({ action: "ap-rename-submit", policyId: other.id }), {
        name: "x",
      }),
    );
    expect(responder.text()).toBe(MSG.outdated);
    expect(await app.policies.get(other.id)).toMatchObject({
      name: "theirs",
      state: "enabled",
      roleIds: ["800"],
    });
  });
});

describe("/autotrack list", () => {
  it("shows the flag lines and channel status", async () => {
    await make();
    await readyGuild(app, { "1": ["700"] });
    await createdPolicy();
    await router.handle(listCmd());
    expect(responder.calls.at(-2)?.kind).toBe("deferEphemeral");
    const text = responder.text();
    expect(text).toContain("Mention auto-track: on");
    expect(text).toContain("Role targets: on");
    expect(text).toMatch(/1 eligible member · limit 100/);
    expect(text).toMatch(/#\d+ · Dev team · enabled · 1 role/);
    app.autoHealth?.set(GUILD, "failed");
    await router.handle(listCmd());
    expect(responder.text()).toContain("paused");
  });

  it("pagination: 23 policies → 10 per page, out of range → last page; select opens a panel", async () => {
    await make();
    await readyGuild(app, {});
    for (let i = 0; i < 23; i++) {
      await app.policies.create({
        guildId: GUILD,
        channelId: CHANNEL,
        name: `p${i}`,
        roleIds: ["700"],
        actor: "9",
        at: T0,
      });
    }
    await router.handle(listCmd());
    expect(responder.text().match(/^#\d+ · /gm)).toHaveLength(10);
    expect(responder.text()).toContain("Page 1 of 3 — use /autotrack list page:<n>");
    await router.handle(listCmd({ page: 3 }));
    expect(responder.text().match(/^#\d+ · /gm)).toHaveLength(3);
    await router.handle(listCmd({ page: 9 }));
    expect(responder.text()).toContain("Page 3 of 3");
    const json = lastJson();
    expect(json).toContain(encodeCustomId({ action: "ap-open", channelId: CHANNEL }));
    const [first] = await app.policies.listForChannel(CHANNEL, { offset: 20, limit: 1 });
    await router.handle(
      selectInteraction(
        encodeCustomId({ action: "ap-open", channelId: CHANNEL }),
        [String(first?.id)],
        { componentType: 3 },
      ),
    );
    expect(responder.text()).toContain(`**${first?.name}**`);
  });

  it("an empty channel says so", async () => {
    await make();
    await router.handle(listCmd({ channelId: "601" }));
    expect(responder.text()).toContain("No auto-track policies in <#601>.");
  });
});

describe("selected-channel permission warning", () => {
  it("uses the resolved selected channel's app_permissions", async () => {
    await make();
    await readyGuild(app, {});
    await router.handle(
      createCmd({
        appPerms: PERMS(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory),
      }),
    );
    expect(responder.text()).toContain("missing permissions in <#600>: SEND_MESSAGES");
    expect(await app.policies.countForChannel(CHANNEL)).toBe(1); // still created
  });

  it("invocation-channel permissions are never used", async () => {
    await make();
    await readyGuild(app, {});
    await router.handle(createCmd({ appPerms: ALL, invocationPerms: "0", name: "ok" }));
    expect(responder.text()).not.toMatch(/missing permissions/i);
  });

  it("absent app_permissions → no warning and no REST lookup", async () => {
    await make();
    await readyGuild(app, {});
    const calls = app.discord.calls.length;
    await router.handle(createCmd({ name: "unknown perms" }));
    expect(responder.text()).not.toMatch(/missing permissions/i);
    // only the index extension for the new role (member state), never a channel/permission lookup
    const methods = app.discord.calls.slice(calls).map((c) => c.method);
    expect(methods.filter((m) => m !== "getGuildRoleIds" && m !== "listGuildMembers")).toEqual([]);
  });
});
