import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { openDatabase, type DatabaseConnection } from "../db/client.ts";
import { CredentialCrypto } from "./credential-crypto.ts";
import { MasterKeyRotationError, rotateMasterKey } from "./master-key-rotation.ts";
import { ProviderCredentialService } from "./provider-credentials.ts";

const directorios: string[] = [];
const abiertas: DatabaseConnection[] = [];
afterEach(() => {
  abiertas.splice(0).forEach((database) => database.close());
  directorios.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function base(): DatabaseConnection {
  const directorio = mkdtempSync(join(tmpdir(), "manteiner-rotacion-"));
  directorios.push(directorio);
  const database = openDatabase(join(directorio, "test.db"));
  abiertas.push(database);
  database.sqlite.prepare(
    `INSERT INTO users (id, github_id, github_login, email_verified, created_at, updated_at)
     VALUES ('user-1', 1, 'one', 0, 1, 1)`,
  ).run();
  return database;
}

function servicio(database: DatabaseConnection, key: Buffer, version: number) {
  return new ProviderCredentialService(
    database,
    new CredentialCrypto(key, version),
    async () => assert.fail("no debe refrescar"),
    100,
  );
}

describe("rotateMasterKey", () => {
  it("re-cifra con la clave nueva y la credencial sigue legible solo con ella", () => {
    const database = base();
    const vieja = randomBytes(32);
    const nueva = randomBytes(32);
    servicio(database, vieja, 1).save("user-1", "anthropic", { type: "api", key: "sk-secreto" });

    const reporte = rotateMasterKey(database, { current: nueva, currentVersion: 2, previous: vieja });
    assert.deepEqual(reporte, { rotated: 1, alreadyCurrent: 0 });

    const conNueva = servicio(database, nueva, 2).getActive("user-1", "anthropic");
    assert.deepEqual(conNueva, { type: "api", key: "sk-secreto" });
    assert.throws(() => servicio(database, vieja, 1).getActive("user-1", "anthropic"));

    // Idempotente: una segunda corrida no toca nada.
    assert.deepEqual(
      rotateMasterKey(database, { current: nueva, currentVersion: 2, previous: vieja }),
      { rotated: 0, alreadyCurrent: 1 },
    );
  });

  it("con una clave anterior equivocada no rota nada", () => {
    const database = base();
    const vieja = randomBytes(32);
    servicio(database, vieja, 1).save("user-1", "anthropic", { type: "api", key: "sk-secreto" });

    assert.throws(() =>
      rotateMasterKey(database, { current: randomBytes(32), currentVersion: 2, previous: randomBytes(32) }),
    );
    const fila = database.sqlite
      .prepare("SELECT key_version FROM provider_credentials").get() as { key_version: number };
    assert.equal(fila.key_version, 1);
    assert.deepEqual(servicio(database, vieja, 1).getActive("user-1", "anthropic"), {
      type: "api",
      key: "sk-secreto",
    });
  });

  it("exige MASTER_KEY_PREVIOUS si hay filas por rotar", () => {
    const database = base();
    servicio(database, randomBytes(32), 1).save("user-1", "anthropic", { type: "api", key: "sk-x" });
    assert.throws(
      () => rotateMasterKey(database, { current: randomBytes(32), currentVersion: 2, previous: null }),
      MasterKeyRotationError,
    );
  });
});
