import type { Generated } from "kysely";
import type { EvidenceKind, StopReason } from "../domain/types.ts";

export interface TrackedMessagesTable {
  id: Generated<number>;
  guild_id: string;
  channel_id: string;
  parent_channel_id: string | null;
  source_message_id: string;
  source_author_id: string;
  source_created_at: number;
  status_message_id: string | null;
  creator_user_id: string;
  created_at: number;
  weak_window_ends_at: number;
  expires_at: number;
  initial_backfill_at: number | null;
  stopped_at: number | null;
  stop_reason: StopReason | null;
  stopped_by_user_id: string | null;
  rendered_hash: string | null;
}

export interface TrackingTargetsTable {
  tracked_message_id: number;
  user_id: string;
  added_by_user_id: string;
  added_at: number;
}

export interface EvidenceTable {
  tracked_message_id: number;
  user_id: string;
  kind: EvidenceKind;
  source_key: string;
  occurred_at: number | null;
  observed_at: number;
}

export interface AcknowledgementsTable {
  tracked_message_id: number;
  user_id: string;
  acknowledged_at: number;
  revoked_at: number | null;
}

export interface BotStateTable {
  key: string;
  value: string;
}

export interface Database {
  tracked_messages: TrackedMessagesTable;
  tracking_targets: TrackingTargetsTable;
  evidence: EvidenceTable;
  acknowledgements: AcknowledgementsTable;
  bot_state: BotStateTable;
}
