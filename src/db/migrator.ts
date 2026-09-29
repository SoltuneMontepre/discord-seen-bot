import type { Kysely } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import { m0001_initial } from "./migrations/0001_initial.ts";
import type { Database } from "./schema.ts";

/** Static provider: forward-only, never edit an applied migration — add a new one. */
const migrations: Record<string, Migration> = {
  "0001_initial": m0001_initial,
};

export async function migrateToLatest(db: Kysely<Database>): Promise<string[]> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}
