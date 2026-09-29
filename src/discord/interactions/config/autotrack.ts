import {
  type APIApplicationCommandInteractionDataOption,
  type APIChatInputApplicationCommandInteraction,
  ApplicationCommandOptionType,
  ChannelType,
  ComponentType,
} from "@discordjs/core";
import type { AutoTrackPolicy } from "../../../db/policy-repository.ts";
import type { PolicyState } from "../../../domain/policy-state.ts";
import { encodeCustomId } from "../../custom-id.ts";
import { missingAppPermissions } from "../../permissions.ts";
import { MSG } from "../../render/text.ts";
import type { InteractionDeps } from "../context.ts";
import type { ResponseData } from "../responder.ts";
import {
  type AutotrackRuntime,
  actorOf,
  autotrackRuntime,
  policyErrorText,
  renderPanel,
} from "./policy-panel.ts";

/** Discord component/message constraint, not a product limit: 10 policies per list page. */
const PAGE_SIZE = 10;
const POLICY_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
]);
const LIST_STATE: Record<PolicyState, string> = {
  enabled: "enabled",
  user_disabled: "disabled",
  auto_disabled_missing_role: "disabled (role deleted)",
};

type Option = APIApplicationCommandInteractionDataOption;

function optionValue(options: readonly Option[] | undefined, name: string): unknown {
  const o = options?.find((x) => x.name === name);
  return o && "value" in o ? o.value : undefined;
}

/** /autotrack create | list (spec §12.1). Deferred and ephemeral. */
export async function handleAutotrack(
  deps: InteractionDeps,
  i: APIChatInputApplicationCommandInteraction,
): Promise<void> {
  const ref = { id: i.id, token: i.token };
  const rt = autotrackRuntime(deps);
  if (!rt) return deps.responder.replyEphemeral(ref, { content: MSG.autotrackDisabled });
  const sub = i.data.options?.[0];
  if (!sub || sub.type !== ApplicationCommandOptionType.Subcommand) {
    return deps.responder.replyEphemeral(ref, { content: MSG.outdated });
  }
  await deps.responder.deferEphemeral(ref);
  const data =
    sub.name === "create" ? await create(rt, i, sub.options) : await list(rt, i, sub.options);
  await deps.responder.editReply(ref, data);
}

async function create(
  rt: AutotrackRuntime,
  i: APIChatInputApplicationCommandInteraction,
  options: readonly Option[] | undefined,
): Promise<ResponseData> {
  const channelId = String(optionValue(options, "channel") ?? "");
  const name = String(optionValue(options, "name") ?? "");
  const roleId = String(optionValue(options, "role") ?? "");
  // The SELECTED channel's resolved data (never the invocation channel's app_permissions).
  const resolved = i.data.resolved?.channels?.[channelId] as
    | { type: number; app_permissions?: string }
    | undefined;
  if (!resolved || !POLICY_CHANNEL_TYPES.has(resolved.type)) {
    return { content: MSG.policyChannelType, components: [] };
  }
  const r = await rt.policyService.create(actorOf(i), { channelId, name, roleId });
  if (!r.ok) return { content: policyErrorText(r), components: [] };
  const missing =
    resolved.app_permissions === undefined
      ? []
      : missingAppPermissions(resolved.app_permissions, false);
  return renderPanel(
    r.value,
    missing.length > 0 ? MSG.policyMissingPerms(channelId, missing) : undefined,
  );
}

async function list(
  rt: AutotrackRuntime,
  i: APIChatInputApplicationCommandInteraction,
  options: readonly Option[] | undefined,
): Promise<ResponseData> {
  const guildId = i.guild_id ?? "";
  const channelId = String(optionValue(options, "channel") ?? i.channel?.id ?? i.channel_id ?? "");
  const onOff = (b: boolean) => (b ? "on" : "off");
  const head = [
    `**Auto-track** · <#${channelId}>`,
    `Mention auto-track: ${onOff(rt.features.mentionAutoTrack)} · Role targets: ${onOff(rt.features.roleTargets)}`,
  ];
  const total = await rt.policies.countForChannel(channelId);
  if (total === 0) {
    return { content: [...head, MSG.policyNone(channelId)].join("\n"), components: [] };
  }
  const status = await rt.policyService.channelStatus(guildId, channelId);
  head.push(`Status: ${statusText(status)}`);
  const pages = Math.ceil(total / PAGE_SIZE);
  const requested = Number(optionValue(options, "page") ?? 1);
  const page = Math.min(Math.max(1, Number.isInteger(requested) ? requested : 1), pages);
  const policies = (
    await rt.policies.listForChannel(channelId, {
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    })
  ).filter((p) => p.guildId === guildId);
  const lines = [...head, "", ...policies.map(listLine)];
  if (pages > 1) lines.push(`-# Page ${page} of ${pages} — use /autotrack list page:<n>`);
  return {
    content: lines.join("\n"),
    components:
      policies.length === 0
        ? []
        : [
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.StringSelect,
                  custom_id: encodeCustomId({ action: "ap-open", channelId }),
                  placeholder: "Open a policy",
                  options: policies.map((p) => ({
                    label: `#${p.id} · ${p.name}`.slice(0, 100),
                    value: String(p.id),
                  })),
                },
              ],
            },
          ],
  };
}

function listLine(p: AutoTrackPolicy): string {
  const n = p.roleIds.length;
  return `#${p.id} · ${p.name} · ${LIST_STATE[p.state]} · ${n} ${n === 1 ? "role" : "roles"}`;
}

function statusText(s: {
  paused: boolean;
  resolved?: number;
  limit: number;
  overLimit: boolean;
}): string {
  if (s.paused) return "⏸ paused — member state is temporarily unavailable";
  const n = s.resolved ?? 0;
  const counts = `${n} eligible ${n === 1 ? "member" : "members"} · limit ${s.limit}`;
  return s.overLimit ? `⚠ over limit — ${counts}` : counts;
}
