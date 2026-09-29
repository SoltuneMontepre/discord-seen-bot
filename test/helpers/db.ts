import { openDatabase } from "../../src/db/database.ts";
import { migrateToLatest } from "../../src/db/migrator.ts";
import { type NewTracking, Repository } from "../../src/db/repository.ts";
import { HOUR, T0 } from "./domain.ts";

export async function createTestDb(path = ":memory:") {
  const handle = openDatabase(path);
  await migrateToLatest(handle.db);
  return { ...handle, repo: new Repository(handle.db) };
}

let seq = 0;
export function newTracking(overrides: Partial<NewTracking> = {}): NewTracking {
  seq += 1;
  return {
    guildId: "500",
    channelId: "600",
    parentChannelId: null,
    sourceMessageId: String(1_000_000 + seq),
    sourceAuthorId: "100",
    sourceCreatedAt: T0 - 10 * 60_000,
    creatorUserId: "100",
    createdAt: T0,
    weakWindowEndsAt: T0 + 2 * HOUR,
    expiresAt: T0 + 7 * 24 * HOUR,
    ...overrides,
  };
}
