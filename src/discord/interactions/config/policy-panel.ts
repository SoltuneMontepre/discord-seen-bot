import {
  type APIButtonComponentWithCustomId,
  type APIMessageComponentInteraction,
  type APIModalSubmitInteraction,
  ButtonStyle,
  ComponentType,
  SelectMenuDefaultValueType,
  TextInputStyle,
} from "@discordjs/core";
import type { ConfigActor } from "../../../app/config-authorizer.ts";
import type { PolicyResult, PolicyService } from "../../../app/policy-service.ts";
import type { AutoTrackPolicy, PolicyRepository } from "../../../db/policy-repository.ts";
import type { PolicyState } from "../../../domain/policy-state.ts";
import { encodeCustomId, type PolicyAction } from "../../custom-id.ts";
import { MSG } from "../../render/text.ts";
import type { InteractionDeps } from "../context.ts";
import type { ModalData, ResponseData } from "../responder.ts";

const ROLE_SELECT_MAX = 25;
const NAME_INPUT_ID = "name";

export const POLICY_STATE_TEXT: Record<PolicyState, string> = {
  enabled: "Enabled",
  user_disabled: "Disabled",
  auto_disabled_missing_role: "Disabled — its last role was deleted. Add a role to re-enable.",
};

export interface AutotrackRuntime {
  features: { mentionAutoTrack: boolean; roleTargets: boolean };
  policies: PolicyRepository;
  policyService: PolicyService;
}

/** The /autotrack feature is live only with role targets on (spec §12.1). */
export function autotrackRuntime(deps: InteractionDeps): AutotrackRuntime | undefined {
  const a = deps.autotrack;
  if (!a?.features.roleTargets || !a.policyService) return undefined;
  return { features: a.features, policies: a.policies, policyService: a.policyService };
}

export function actorOf(i: {
  guild_id?: string;
  member?: { user: { id: string }; permissions?: string };
  user?: { id: string };
}): ConfigActor {
  return {
    userId: i.member?.user.id ?? i.user?.id ?? "0",
    guildId: i.guild_id,
    memberPermissions: i.member?.permissions,
  };
}

export function policyErrorText(r: Extract<PolicyResult<unknown>, { ok: false }>): string {
  switch (r.error) {
    case "paused":
      return MSG.policyPaused;
    case "over_limit":
      return MSG.policyOverLimit(r.detail?.resolved ?? 0, r.detail?.limit ?? 0);
    case "needs_role":
      return MSG.policyNeedsRole;
    case "everyone_role":
      return MSG.policyEveryone;
    case "invalid_name":
      return MSG.policyInvalidName;
    case "invalid_state":
      return MSG.policyInvalidState;
    case "not_found":
      return MSG.outdated;
  }
}

const cid = (action: PolicyAction, policyId: number) => encodeCustomId({ action, policyId });

function stateButton(p: AutoTrackPolicy): APIButtonComponentWithCustomId {
  const button = (
    label: string,
    style: ButtonStyle.Secondary | ButtonStyle.Success,
    action: PolicyAction,
  ): APIButtonComponentWithCustomId => ({
    type: ComponentType.Button,
    label,
    style,
    custom_id: cid(action, p.id),
  });
  switch (p.state) {
    case "enabled":
      return button("Disable", ButtonStyle.Secondary, "ap-disable");
    case "user_disabled":
      return button("Enable", ButtonStyle.Success, "ap-enable");
    case "auto_disabled_missing_role":
      return button("Keep disabled", ButtonStyle.Secondary, "ap-keep");
  }
}

/** The single-policy panel (spec §12.2). Role mentions render here only; nothing pings. */
export function renderPanel(p: AutoTrackPolicy, note?: string): ResponseData {
  const roles = p.roleIds.length > 0 ? p.roleIds.map((r) => `<@&${r}>`).join(", ") : "none";
  const lines = [
    `**${p.name}** · <#${p.channelId}> · #${p.id}`,
    `State: ${POLICY_STATE_TEXT[p.state]}`,
    `Roles: ${roles}`,
  ];
  if (note) lines.push("", note);
  return {
    content: lines.join("\n"),
    allowed_mentions: { parse: [] },
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.RoleSelect,
            custom_id: cid("ap-roles", p.id),
            placeholder: "Roles whose members are targets",
            min_values: 1,
            max_values: ROLE_SELECT_MAX,
            default_values: p.roleIds.slice(0, ROLE_SELECT_MAX).map((id) => ({
              id,
              type: SelectMenuDefaultValueType.Role,
            })),
          },
        ],
      },
      {
        type: ComponentType.ActionRow,
        components: [
          stateButton(p),
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            custom_id: cid("ap-rename", p.id),
            label: "Rename",
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            custom_id: cid("ap-delete", p.id),
            label: "Delete",
          },
        ],
      },
    ],
  };
}

function renameModal(p: AutoTrackPolicy): ModalData {
  return {
    custom_id: cid("ap-rename-submit", p.id),
    title: "Rename policy",
    components: [
      {
        type: ComponentType.Label,
        label: "Name",
        component: {
          type: ComponentType.TextInput,
          custom_id: NAME_INPUT_ID,
          style: TextInputStyle.Short,
          min_length: 1,
          max_length: 100,
          required: true,
          value: p.name,
        },
      },
    ],
  };
}

function deleteConfirm(p: AutoTrackPolicy): ResponseData {
  return {
    content: MSG.policyDeleteConfirm(p.name),
    allowed_mentions: { parse: [] },
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            custom_id: cid("ap-delete-confirm", p.id),
            label: "Delete",
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            custom_id: cid("ap-view", p.id),
            label: "Cancel",
          },
        ],
      },
    ],
  };
}

type PanelInteraction = APIMessageComponentInteraction | APIModalSubmitInteraction;

/** Read-only load with tenant isolation (a forged id from another guild is "outdated"). */
async function loadOwn(rt: AutotrackRuntime, i: PanelInteraction, policyId: number) {
  const p = await rt.policies.get(policyId);
  return p && p.guildId === i.guild_id ? p : undefined;
}

/** Deferred-update mutation: panel on success, panel + error note on a rule error. */
async function mutate(
  deps: InteractionDeps,
  rt: AutotrackRuntime,
  i: PanelInteraction,
  policyId: number,
  run: () => Promise<PolicyResult<AutoTrackPolicy>>,
): Promise<void> {
  const ref = { id: i.id, token: i.token };
  await deps.responder.deferUpdate(ref);
  const r = await run();
  if (r.ok) return deps.responder.editReply(ref, renderPanel(r.value));
  const p = r.error === "not_found" ? undefined : await loadOwn(rt, i, policyId);
  if (!p) return deps.responder.editReply(ref, { content: MSG.outdated, components: [] });
  return deps.responder.editReply(ref, renderPanel(p, policyErrorText(r)));
}

export async function handlePolicyComponent(
  deps: InteractionDeps,
  i: APIMessageComponentInteraction,
  action: PolicyAction,
  policyId: number,
): Promise<void> {
  const ref = { id: i.id, token: i.token };
  const rt = autotrackRuntime(deps);
  if (!rt) return deps.responder.replyEphemeral(ref, { content: MSG.autotrackDisabled });
  const actor = actorOf(i);
  const svc = rt.policyService;
  switch (action) {
    case "ap-roles": {
      const values = "values" in i.data ? [...i.data.values] : [];
      return mutate(deps, rt, i, policyId, () => svc.saveRoles(actor, policyId, values));
    }
    case "ap-enable":
      return mutate(deps, rt, i, policyId, () => svc.setState(actor, policyId, "enable"));
    case "ap-disable":
      return mutate(deps, rt, i, policyId, () => svc.setState(actor, policyId, "disable"));
    case "ap-keep":
      return mutate(deps, rt, i, policyId, () => svc.setState(actor, policyId, "keep_disabled"));
    case "ap-delete-confirm": {
      await deps.responder.deferUpdate(ref);
      const r = await svc.delete(actor, policyId);
      return deps.responder.editReply(ref, {
        content: r.ok ? MSG.policyDeleted : policyErrorText(r),
        components: [],
      });
    }
    case "ap-rename":
    case "ap-delete":
    case "ap-view": {
      const p = await loadOwn(rt, i, policyId);
      if (!p) return deps.responder.replyEphemeral(ref, { content: MSG.outdated });
      if (action === "ap-rename") return deps.responder.showModal(ref, renameModal(p));
      return deps.responder.update(ref, action === "ap-delete" ? deleteConfirm(p) : renderPanel(p));
    }
    case "ap-rename-submit":
      return deps.responder.replyEphemeral(ref, { content: MSG.outdated });
  }
}

/** String select on the /autotrack list message → that policy's panel. */
export async function handlePolicyOpen(
  deps: InteractionDeps,
  i: APIMessageComponentInteraction,
  channelId: string,
): Promise<void> {
  const ref = { id: i.id, token: i.token };
  const rt = autotrackRuntime(deps);
  if (!rt) return deps.responder.replyEphemeral(ref, { content: MSG.autotrackDisabled });
  const raw = "values" in i.data ? i.data.values[0] : undefined;
  const policyId = raw !== undefined && /^\d{1,16}$/.test(raw) ? Number(raw) : 0;
  const p = policyId > 0 ? await loadOwn(rt, i, policyId) : undefined;
  if (!p || p.channelId !== channelId) {
    return deps.responder.replyEphemeral(ref, { content: MSG.outdated });
  }
  return deps.responder.update(ref, renderPanel(p));
}

function modalValue(i: APIModalSubmitInteraction, customId: string): string | undefined {
  for (const c of i.data.components as unknown as {
    type: number;
    component?: { custom_id: string; value?: string };
    components?: { custom_id: string; value?: string }[];
  }[]) {
    const inputs = c.component ? [c.component] : (c.components ?? []);
    const hit = inputs.find((x) => x.custom_id === customId);
    if (hit) return hit.value;
  }
  return undefined;
}

export async function handleRenameSubmit(
  deps: InteractionDeps,
  i: APIModalSubmitInteraction,
  policyId: number,
): Promise<void> {
  const ref = { id: i.id, token: i.token };
  const rt = autotrackRuntime(deps);
  if (!rt) return deps.responder.replyEphemeral(ref, { content: MSG.autotrackDisabled });
  const name = modalValue(i, NAME_INPUT_ID) ?? "";
  return mutate(deps, rt, i, policyId, () => rt.policyService.rename(actorOf(i), policyId, name));
}
