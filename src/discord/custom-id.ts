import type { Snowflake } from "../domain/types.ts";

/**
 * custom_id format: `sb1:<action>:<arg>`. No user ids, no state — handlers are stateless and load
 * everything from SQLite; identity always comes from the interaction payload.
 */
export const CUSTOM_ID_PREFIX = "sb1";

export type CustomId =
  | { action: "ack" | "manage" | "undo" | "targets" | "stop"; trackedId: number }
  | { action: "pick"; sourceMessageId: Snowflake };

const TRACKED_ACTIONS = new Set(["ack", "manage", "undo", "targets", "stop"]);

export function encodeCustomId(id: CustomId): string {
  const arg = id.action === "pick" ? id.sourceMessageId : String(id.trackedId);
  return `${CUSTOM_ID_PREFIX}:${id.action}:${arg}`;
}

/** Returns null for foreign, outdated or malformed ids. */
export function decodeCustomId(raw: string): CustomId | null {
  if (raw.length > 100) return null;
  const parts = raw.split(":");
  if (parts.length !== 3 || parts[0] !== CUSTOM_ID_PREFIX) return null;
  const [, action, arg] = parts as [string, string, string];
  if (!/^\d{1,20}$/.test(arg)) return null;
  if (action === "pick") return { action, sourceMessageId: arg };
  if (!TRACKED_ACTIONS.has(action)) return null;
  const trackedId = Number(arg);
  if (!Number.isSafeInteger(trackedId) || trackedId <= 0) return null;
  return { action: action as "ack", trackedId };
}
