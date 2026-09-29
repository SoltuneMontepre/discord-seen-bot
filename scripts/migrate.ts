/** Applies pending migrations explicitly (the bot also migrates on startup). */
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/database.ts";
import { migrateToLatest } from "../src/db/migrator.ts";

const config = loadConfig();
const { db, close } = openDatabase(config.databasePath);
const applied = await migrateToLatest(db);
console.log(applied.length > 0 ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
await close();
