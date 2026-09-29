import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Database } from "./schema.ts";

export interface DatabaseHandle {
  db: Kysely<Database>;
  close(): Promise<void>;
}

/** Opens SQLite with the pragmas from the plan. Single process, single writer. */
export function openDatabase(path: string): DatabaseHandle {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new BetterSqlite3(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  return { db, close: () => db.destroy() };
}
