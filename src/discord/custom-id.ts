import type { Snowflake } from "../domain/types.ts";

/**
 * custom_id format: `sb1:<action>:<arg>`. No user ids, no state — handlers are stateless and load
 * everything from SQLite; identity always comes from the interaction payload.
 */
export const CUSTOM_ID_PREFIX = "sb1";

/** M9 policy panel actions (arg = policy id). State buttons encode their intent. */
export type PolicyAction =
  | "ap-roles"
  | "ap-enable"
  | "ap-disable"
  | "ap-keep"
  | "ap-rename"
  | "ap-rename-submit"
  | "ap-delete"
  | "ap-delete-confirm"
  | "ap-view";

export type CustomId =
  | { action: "ack" | "manage" | "undo" | "targets" | "stop"; trackedId: number }
  | { action: "pick"; sourceMessageId: Snowflake }
  | { action: PolicyAction; policyId: number }
  | { action: "ap-open"; channelId: Snowflake };

const TRACKED_ACTIONS = new Set(["ack", "manage", "undo", "targets", "stop"]);
const POLICY_ACTIONS = new Set<string>([
  "ap-roles",
  "ap-enable",
  "ap-disable",
  "ap-keep",
  "ap-rename",
  "ap-rename-submit",
  "ap-delete",
  "ap-delete-confirm",
  "ap-view",
]);

function argOf(id: CustomId): string {
  if ("trackedId" in id) return String(id.trackedId);
  if ("policyId" in id) return String(id.policyId);
  if ("channelId" in id) return id.channelId;
  return id.sourceMessageId;
}

export function encodeCustomId(id: CustomId): string {
  return `${CUSTOM_ID_PREFIX}:${id.action}:${argOf(id)}`;
}

function positiveId(arg: string): number | null {
  const n = Number(arg);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Returns null for foreign, outdated or malformed ids. */
export function decodeCustomId(raw: string): CustomId | null {
  if (raw.length > 100) return null;
  const parts = raw.split(":");
  if (parts.length !== 3 || parts[0] !== CUSTOM_ID_PREFIX) return null;
  const [, action, arg] = parts as [string, string, string];
  if (!/^\d{1,20}$/.test(arg)) return null;
  if (action === "pick") return { action, sourceMessageId: arg };
  if (action === "ap-open") return { action, channelId: arg };
  const n = positiveId(arg);
  if (n === null) return null;
  if (POLICY_ACTIONS.has(action)) return { action: action as PolicyAction, policyId: n };
  if (!TRACKED_ACTIONS.has(action)) return null;
  return { action: action as "ack", trackedId: n };
}
