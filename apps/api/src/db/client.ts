import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseConnection {
  readonly db: AppDatabase;
  readonly sqlite: BetterSqlite3.Database;
  readonly path: string;
  close(): void;
}

export function openDatabase(databasePath: string): DatabaseConnection {
  const resolvedPath = resolveDatabasePath(databasePath);
  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  const sqlite = new BetterSqlite3(resolvedPath);

  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");

    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    return {
      db,
      sqlite,
      path: resolvedPath,
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function resolveDatabasePath(databasePath: string): string {
  if (databasePath === ":memory:" || isAbsolute(databasePath)) return databasePath;
  return resolve(PROJECT_ROOT, databasePath);
}
