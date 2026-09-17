import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { Config } from "../config.ts";
import { openDatabase, type DatabaseConnection } from "../db/client.ts";
import { OrphanCleanupService, type CleanupDockerClient } from "./docker-cleanup.ts";

const directories: string[] = [];
const abiertas: DatabaseConnection[] = [];
afterEach(() => {
  abiertas.splice(0).forEach((database) => database.close());
  directories.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const config = { DOCKER_SOCKET: undefined } as unknown as Config;

function baseDatos(): DatabaseConnection {
  const directory = mkdtempSync(join(tmpdir(), "manteiner-cleanup-"));
  directories.push(directory);
  const database = openDatabase(join(directory, "test.db"));
  abiertas.push(database);
  database.sqlite.prepare(
    `INSERT INTO users (id, github_id, github_login, email_verified, created_at, updated_at)
     VALUES ('user-1', 1, 'one', 0, 1, 1)`,
  ).run();
  database.sqlite.prepare(
    `INSERT INTO github_installations
      (id, installation_id, account_login, account_type, repository_selection, created_at, updated_at)
     VALUES ('inst-1', 1, 'one', 'User', 'all', 1, 1)`,
  ).run();
  database.sqlite.prepare(
    `INSERT INTO repositories
      (id, user_id, installation_id, github_repo_id, owner, name, full_name, default_branch,
       private, html_url, linked_at)
     VALUES ('repo-1', 'user-1', 'inst-1', 1, 'one', 'r', 'one/r', 'main', 0, 'https://x', 1)`,
  ).run();
  return database;
}

function conRun(database: DatabaseConnection, id: string, status: string): void {
  database.sqlite.prepare(
    `INSERT INTO runs
      (id, user_id, repository_id, audit_type, status, provider_id, model_id, agent_version,
       schema_version, queued_at, started_at)
     VALUES (?, 'user-1', 'repo-1', 'maintenance', ?, 'openai', 'm', 'maintenance@1', '1.0.0', 1, 1000)`,
  ).run(id, status);
}

function dockerFalso(
  contenedores: string[],
  volumenes: string[],
  fallar: { contenedor?: string; volumen?: string } = {},
): { client: CleanupDockerClient; borrados: string[] } {
  const borrados: string[] = [];
  return {
    borrados,
    client: {
      listContainers: async () => contenedores.map((Id) => ({ Id })),
      getContainer: (id) => ({
        remove: async () => {
          if (id === fallar.contenedor) throw new Error("no se pudo");
          borrados.push(`c:${id}`);
        },
      }),
      listVolumes: async () => ({ Volumes: volumenes.map((Name) => ({ Name })) }),
      getVolume: (name) => ({
        remove: async () => {
          if (name === fallar.volumen) throw new Error("no se pudo");
          borrados.push(`v:${name}`);
        },
      }),
    },
  };
}

describe("OrphanCleanupService", () => {
  it("cierra los runs que quedaron vivos y borra contenedores y volumenes", async () => {
    const database = baseDatos();
    conRun(database, "run-preparing", "preparing");
    conRun(database, "run-running", "running");
    conRun(database, "run-ok", "succeeded");
    const { client, borrados } = dockerFalso(
      ["abc123def456", "otro"],
      ["manteiner-ws-1", "manteiner-ws-2", "volumen-ajeno"],
    );

    const reporte = await new OrphanCleanupService(database, config, client, () => 9_000).run();

    assert.equal(reporte.runs, 2);
    assert.equal(reporte.containers, 2);
    assert.equal(reporte.volumes, 2);
    assert.deepEqual(reporte.failures, []);
    // Un volumen que no es nuestro no se toca.
    assert.ok(!borrados.includes("v:volumen-ajeno"));

    const filas = database.sqlite
      .prepare("SELECT id, status, error_code, duration_ms FROM runs ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      filas.map((fila) => [fila["id"], fila["status"], fila["error_code"]]),
      [
        ["run-ok", "succeeded", null],
        ["run-preparing", "failed", "SERVER_RESTART"],
        ["run-running", "failed", "SERVER_RESTART"],
      ],
    );
    assert.equal(filas[1]!["duration_ms"], 8_000);
  });

  it("informa lo que no pudo borrar en vez de fallar el arranque", async () => {
    const database = baseDatos();
    const { client } = dockerFalso(["vivo"], ["manteiner-ws-1"], {
      contenedor: "vivo",
      volumen: "manteiner-ws-1",
    });

    const reporte = await new OrphanCleanupService(database, config, client).run();

    assert.equal(reporte.containers, 0);
    assert.equal(reporte.volumes, 0);
    assert.deepEqual(reporte.failures, ["container:vivo", "volume:manteiner-ws-1"]);
  });

  it("no rompe si Docker no esta disponible", async () => {
    const database = baseDatos();
    conRun(database, "run-running", "running");
    const client: CleanupDockerClient = {
      listContainers: async () => {
        throw new Error("daemon apagado");
      },
      getContainer: () => assert.fail("no deberia consultarse"),
      listVolumes: async () => {
        throw new Error("daemon apagado");
      },
      getVolume: () => assert.fail("no deberia consultarse"),
    };

    const reporte = await new OrphanCleanupService(database, config, client).run();

    // Los runs se cierran igual: eso no depende de Docker.
    assert.equal(reporte.runs, 1);
    assert.deepEqual(reporte.failures, ["containers", "volumes"]);
  });
});
