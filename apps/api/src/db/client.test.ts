import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import BetterSqlite3 from "better-sqlite3";

import { openDatabase, type DatabaseConnection } from "./client.ts";

const temporaryDirectories: string[] = [];
const openConnections: DatabaseConnection[] = [];

function temporaryDatabase(): DatabaseConnection {
  const directory = mkdtempSync(join(tmpdir(), "manteiner-db-"));
  temporaryDirectories.push(directory);
  const connection = openDatabase(join(directory, "manteiner.db"));
  openConnections.push(connection);
  return connection;
}

afterEach(() => {
  for (const connection of openConnections.splice(0)) {
    if (connection.sqlite.open) connection.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("openDatabase", () => {
  it("aplica la migracion inicial completa", () => {
    const { sqlite } = temporaryDatabase();
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;

    assert.deepEqual(
      rows.map((row) => row.name).filter((name) => !name.startsWith("sqlite_")),
      [
        "__drizzle_migrations",
        "accounts",
        "github_installations",
        "provider_credentials",
        "repositories",
        "run_artifacts",
        "run_events",
        "run_findings",
        "run_steps",
        "runs",
        "sessions",
        "user_model_preferences",
        "users",
        "verifications",
      ],
    );
  });

  it("configura WAL, foreign keys y busy timeout", () => {
    const { sqlite } = temporaryDatabase();

    assert.equal(sqlite.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(sqlite.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(sqlite.pragma("busy_timeout", { simple: true }), 5000);
  });

  it("aplica las migraciones de forma idempotente", () => {
    const first = temporaryDatabase();
    const path = first.path;
    first.close();

    const second = openDatabase(path);
    openConnections.push(second);

    const migrations = second.sqlite
      .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
      .get() as { count: number };
    assert.equal(migrations.count, 2);
  });

  it("migra usuarios previos, vincula GitHub y normaliza emails duplicados", () => {
    const directory = mkdtempSync(join(tmpdir(), "manteiner-db-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "manteiner.db");
    const legacy = new BetterSqlite3(path);
    const initialMigration = readFileSync(
      new URL("./migrations/0000_init.sql", import.meta.url),
      "utf8",
    );
    legacy.exec(initialMigration);
    legacy.exec(`
      CREATE TABLE __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      );
      INSERT INTO __drizzle_migrations (hash, created_at)
      VALUES ('legacy', 1789483948204);
    `);
    const insertUser = legacy.prepare(
      "INSERT INTO users (id, github_id, github_login, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertUser.run("user-1", 1, "octocat", "Octocat", "Same@Example.com", 1, 1);
    insertUser.run("user-2", 2, "monalisa", "Mona Lisa", "same@example.com", 1, 1);
    legacy.close();

    const connection = openDatabase(path);
    openConnections.push(connection);

    const accounts = connection.sqlite
      .prepare("SELECT account_id, user_id FROM accounts ORDER BY user_id")
      .all();
    assert.deepEqual(accounts, [
      { account_id: "1", user_id: "user-1" },
      { account_id: "2", user_id: "user-2" },
    ]);
    const emails = connection.sqlite.prepare("SELECT email FROM users ORDER BY id").all();
    assert.deepEqual(emails, [{ email: "same@example.com" }, { email: null }]);
  });

  it("hace cumplir las foreign keys", () => {
    const { sqlite } = temporaryDatabase();
    assert.throws(() =>
      sqlite
        .prepare(
          "INSERT INTO sessions (id, token, user_id, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("session-1", "token-1", "user-inexistente", 1, 1, 2),
    );
  });

  it("permite una sola preferencia global por usuario", () => {
    const { sqlite } = temporaryDatabase();
    sqlite
      .prepare(
        "INSERT INTO users (id, github_id, github_login, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("user-1", 1, "octocat", "Octocat", "octocat@example.com", 1, 1);

    const insert = sqlite.prepare(
      "INSERT INTO user_model_preferences (id, user_id, repository_id, provider_id, model_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
    );
    insert.run("pref-1", "user-1", "openai", "gpt-5.6-sol", 1, 1);

    assert.throws(() => insert.run("pref-2", "user-1", "openai", "gpt-5.4", 1, 1));
  });

  it("permite una sola preferencia por usuario y repositorio", () => {
    const { sqlite } = temporaryDatabase();
    sqlite
      .prepare(
        "INSERT INTO users (id, github_id, github_login, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("user-1", 1, "octocat", "Octocat", "octocat@example.com", 1, 1);
    sqlite
      .prepare(
        "INSERT INTO repositories (id, user_id, github_repo_id, owner, name, full_name, default_branch, html_url, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("repo-1", "user-1", 10, "octocat", "hello-world", "octocat/hello-world", "main", "https://github.com/octocat/hello-world", 1);

    const insert = sqlite.prepare(
      "INSERT INTO user_model_preferences (id, user_id, repository_id, provider_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("pref-1", "user-1", "repo-1", "openai", "gpt-5.6-sol", 1, 1);

    assert.throws(() =>
      insert.run("pref-2", "user-1", "repo-1", "openai", "gpt-5.4", 1, 1),
    );
  });
});
