import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Unique temp SQLite path plus a cleanup that removes the db and its WAL/SHM files. */
export function tempDbPath(label: string): { path: string; cleanup: () => void } {
  const path = join(
    tmpdir(),
    `seen-bot-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return {
    path,
    cleanup: () => {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    },
  };
}
