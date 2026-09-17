import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openDatabase } from "../db/client.ts";
import { AppError } from "../errors.ts";
import { CredentialCrypto } from "./credential-crypto.ts";
import { ModelPreferenceService } from "./model-preferences.ts";
import { ProviderCatalogService } from "./provider-catalog.ts";
import { ProviderCredentialService } from "./provider-credentials.ts";

describe("ModelPreferenceService", () => {
  it("actualiza preferencia global y aisla overrides por propietario", async () => {
    const directory = mkdtempSync(join(tmpdir(), "manteiner-preferences-"));
    const database = openDatabase(join(directory, "test.db"));
    try {
      database.sqlite.prepare(
        `INSERT INTO users (id, github_id, github_login, email_verified, created_at, updated_at)
         VALUES ('user-1', 1, 'one', 0, 1, 1), ('user-2', 2, 'two', 0, 1, 1)`,
      ).run();
      database.sqlite.prepare(
        `INSERT INTO repositories
          (id, user_id, github_repo_id, owner, name, full_name, default_branch, private, html_url, linked_at)
         VALUES ('11111111-1111-4111-8111-111111111111', 'user-1', 10, 'one', 'repo', 'one/repo', 'main', 0, 'https://github.com/one/repo', 1)`,
      ).run();
      const credentials = new ProviderCredentialService(
        database,
        new CredentialCrypto(randomBytes(32)),
        async () => assert.fail("no debe refrescar"),
        100,
      );
      credentials.save("user-1", "openai", { type: "api", key: "secret" });
      const catalog = new ProviderCatalogService({
        runtime: {
          getCatalog: async () => [{
            id: "openai",
            name: "OpenAI",
            models: [
              { id: "model-a", name: "A", capabilities: { toolcall: true } },
              { id: "model-b", name: "B", capabilities: { toolcall: true } },
            ],
          }],
          validateApiKey: async () => {},
        },
        cachePath: join(directory, "catalog.json"),
        maxAgeMs: 86_400_000,
      });
      const service = new ModelPreferenceService(database, credentials, catalog);

      assert.equal(service.getGlobal("user-1"), null);

      const first = await service.setGlobal("user-1", { providerId: "openai", modelId: "model-a" });
      const replaced = await service.setGlobal("user-1", { providerId: "openai", modelId: "model-b" });
      assert.equal(first.id, replaced.id);
      assert.equal(replaced.modelId, "model-b");
      assert.equal(
        (database.sqlite.prepare("SELECT count(*) AS count FROM user_model_preferences").get() as { count: number }).count,
        1,
      );

      // La lectura global ignora los overrides por repositorio.
      assert.deepEqual(service.getGlobal("user-1"), replaced);
      assert.equal(service.getGlobal("user-2"), null);

      const override = await service.setForRepository(
        "user-1",
        "11111111-1111-4111-8111-111111111111",
        { providerId: "openai", modelId: "model-a", smallModelId: "model-b" },
      );
      assert.equal(override.repositoryId, "11111111-1111-4111-8111-111111111111");
      await assert.rejects(
        service.setForRepository(
          "user-2",
          "11111111-1111-4111-8111-111111111111",
          { providerId: "openai", modelId: "model-a" },
        ),
        (error) => error instanceof AppError && error.statusCode === 404,
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
