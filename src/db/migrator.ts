import { type Kysely, sql } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import { m0001_initial } from "./migrations/0001_initial.ts";
import { m0002_auto_track } from "./migrations/0002_auto_track.ts";
import type { Database } from "./schema.ts";

/** Static provider: forward-only, never edit an applied migration — add a new one. */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  "0001_initial": m0001_initial,
  "0002_auto_track": m0002_auto_track,
};

function migrator(db: Kysely<Database>): Migrator {
  return new Migrator({ db, provider: { getMigrations: async () => ({ ...MIGRATIONS }) } });
}

/**
 * PRAGMA foreign_keys is a no-op inside a transaction, and migrations that rebuild tables (0002) run
 * their own transaction (Kysely's SQLite adapter does not wrap migrations; see 0002). Foreign keys are
 * therefore switched off BEFORE the migrator starts, always restored afterwards, and a final
 * foreign_key_check must be clean.
 */
async function withForeignKeysOff<T>(db: Kysely<Database>, run: () => Promise<T>): Promise<T> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    return await run();
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

async function assertForeignKeysClean(db: Kysely<Database>): Promise<void> {
  const violations = await sql`PRAGMA foreign_key_check`.execute(db);
  if (violations.rows.length > 0) {
    throw new Error(
      `foreign key check failed after migration (${violations.rows.length} violation(s))`,
    );
  }
}

function unwrap(outcome: Awaited<ReturnType<Migrator["migrateToLatest"]>>): string[] {
  if (outcome.error) {
    throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
  }
  return (outcome.results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}

export async function migrateToLatest(db: Kysely<Database>): Promise<string[]> {
  const applied = await withForeignKeysOff(db, async () =>
    unwrap(await migrator(db).migrateToLatest()),
  );
  await assertForeignKeysClean(db);
  return applied;
}

/** Tests: migrate up (or down) to a named migration. */
export async function migrateTo(db: Kysely<Database>, name: string): Promise<string[]> {
  const applied = await withForeignKeysOff(db, async () =>
    unwrap(await migrator(db).migrateTo(name)),
  );
  await assertForeignKeysClean(db);
  return applied;
}
