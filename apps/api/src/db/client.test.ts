import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

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
    assert.equal(migrations.count, 1);
  });

  it("hace cumplir las foreign keys", () => {
    const { sqlite } = temporaryDatabase();
    assert.throws(() =>
      sqlite
        .prepare(
          "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        )
        .run("session-1", "user-inexistente", 1, 2),
    );
  });

  it("permite una sola preferencia global por usuario", () => {
    const { sqlite } = temporaryDatabase();
    sqlite
      .prepare(
        "INSERT INTO users (id, github_id, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("user-1", 1, "octocat", 1, 1);

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
        "INSERT INTO users (id, github_id, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("user-1", 1, "octocat", 1, 1);
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
