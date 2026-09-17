import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { openDatabase, type DatabaseConnection } from "../db/client.ts";
import { AppError } from "../errors.ts";
import { CredentialCrypto } from "./credential-crypto.ts";
import { ProviderCredentialService } from "./provider-credentials.ts";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe("ProviderCredentialService", () => {
  it("guarda cifrado, lista metadata segura y elimina por propietario", () => {
    const { database, directory } = createDatabase();
    const service = new ProviderCredentialService(
      database,
      new CredentialCrypto(randomBytes(32)),
      async () => assert.fail("no debe refrescar"),
      100,
      () => 1_000,
    );

    const saved = service.save("user-1", "anthropic", { type: "api", key: "sk-secret-1234" }, {
      label: "Personal",
    });
    assert.equal(saved.lastFour, "1234");
    const raw = database.sqlite.prepare("SELECT ciphertext FROM provider_credentials").get() as { ciphertext: Buffer };
    assert.doesNotMatch(raw.ciphertext.toString("utf8"), /sk-secret/);
    assert.doesNotMatch(JSON.stringify(service.list("user-1")), /sk-secret/);
    assert.throws(() => service.delete("user-2", saved.id), (error) => error instanceof AppError && error.statusCode === 404);
    service.delete("user-1", saved.id);
    assert.deepEqual(service.list("user-1"), []);
    cleanup(database, directory);
  });

  it("refresca cerca del vencimiento, persiste la rotacion y marca invalid si falla", async () => {
    const { database, directory } = createDatabase();
    let fail = false;
    let refreshes = 0;
    const crypto = new CredentialCrypto(randomBytes(32));
    const service = new ProviderCredentialService(
      database,
      crypto,
      async (current) => {
        refreshes += 1;
        if (fail) throw new Error("revocado");
        return { ...current, access: "new-access", refresh: "new-refresh", expires: 10_000 };
      },
      100,
      () => 1_000,
    );
    service.save("user-1", "openai", {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: 1_050,
      accountId: "account",
    });

    const usable = await service.getUsable("user-1", "openai");
    assert.equal(refreshes, 1);
    assert.deepEqual(usable, {
      type: "oauth",
      access: "new-access",
      refresh: "new-refresh",
      expires: 10_000,
      accountId: "account",
    });
    assert.equal(usable.type, "oauth");
    if (usable.type !== "oauth") assert.fail("se esperaba una credencial OAuth");
    assert.deepEqual(service.getActive("user-1", "openai"), usable);

    service.save("user-1", "openai", { ...usable, expires: 1_050 });
    fail = true;
    await assert.rejects(
      service.getUsable("user-1", "openai"),
      (error) => error instanceof AppError && error.code === "PROVIDER_REFRESH_FAILED",
    );
    assert.equal(service.list("user-1")[0]?.status, "invalid");
    cleanup(database, directory);
  });

  it("serializa refreshes concurrentes del mismo token rotativo", async () => {
    const { database, directory } = createDatabase();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshes = 0;
    const service = new ProviderCredentialService(
      database,
      new CredentialCrypto(randomBytes(32)),
      async (current) => {
        refreshes += 1;
        await gate;
        return { ...current, access: "new-access", refresh: "new-refresh", expires: 10_000 };
      },
      100,
      () => 1_000,
    );
    service.save("user-1", "openai", {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: 1_050,
    });

    const first = service.getUsable("user-1", "openai");
    const second = service.getUsable("user-1", "openai");
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(refreshes, 1);
    assert.deepEqual(firstResult, secondResult);
    assert.equal(service.list("user-1")[0]?.status, "active");
    cleanup(database, directory);
  });
});

function createDatabase(): { database: DatabaseConnection; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "manteiner-providers-"));
  const database = openDatabase(join(directory, "test.db"));
  database.sqlite.prepare(
    `INSERT INTO users (id, github_id, github_login, email_verified, created_at, updated_at)
     VALUES ('user-1', 1, 'one', 0, 1, 1), ('user-2', 2, 'two', 0, 1, 1)`,
  ).run();
  return { database, directory };
}

function cleanup(database: DatabaseConnection, directory: string): void {
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
}
