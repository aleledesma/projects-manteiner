import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { AppError } from "../errors.ts";
import { ProviderCatalogService, type OpencodeProviderRuntime } from "./provider-catalog.ts";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("ProviderCatalogService", () => {
  it("cachea el catalogo y valida modelos utilizables", async () => {
    const directory = mkdtempSync(join(tmpdir(), "manteiner-catalog-"));
    directories.push(directory);
    let calls = 0;
    const runtime: OpencodeProviderRuntime = {
      getCatalog: async () => {
        calls += 1;
        return [{
          id: "openai",
          name: "OpenAI",
          models: [{
            id: "gpt-tools",
            name: "GPT Tools",
            capabilities: { toolcall: true },
            cost: { input: 1, output: 2 },
          }],
        }];
      },
      validateApiKey: async () => {},
    };
    const service = new ProviderCatalogService({
      runtime,
      cachePath: join(directory, "provider-catalog.json"),
      maxAgeMs: 86_400_000,
      now: () => 1_000,
    });

    assert.equal((await service.get()).providers[0]?.models[0]?.id, "gpt-tools");
    assert.equal((await service.get()).providers[0]?.models[0]?.id, "gpt-tools");
    assert.equal(calls, 1);
    await service.assertUsableModel("openai", "gpt-tools");
    await assert.rejects(
      service.assertUsableModel("openai", "gpt-no-tools"),
      (error) => error instanceof AppError && error.code === "MODEL_NOT_USABLE",
    );
  });

  it("conserva proveedores de otras credenciales y no refresca en cada lectura", async () => {
    const directory = mkdtempSync(join(tmpdir(), "manteiner-catalog-merge-"));
    directories.push(directory);
    let corridas = 0;
    const modelo = (id: string) => ({ id, name: id, capabilities: { toolcall: true as const } });
    const service = new ProviderCatalogService({
      runtime: {
        // opencode solo expone los proveedores configurados en esa corrida.
        getCatalog: async (credential) => {
          corridas += 1;
          const base = [{ id: "opencode", name: "opencode", models: [modelo("zen")] }];
          if (!credential) return base;
          return [
            { id: credential.providerId, name: credential.providerId, models: [modelo(`${credential.providerId}-tools`)] },
            ...base,
          ];
        },
        validateApiKey: async () => {},
      },
      cachePath: join(directory, "provider-catalog.json"),
      maxAgeMs: 86_400_000,
      now: () => 1_000,
    });

    const payload = { type: "api", key: "k" } as const;
    await service.refresh({ providerId: "openai", payload });
    const conAnthropic = await service.refresh({ providerId: "anthropic", payload });

    // El refresco de anthropic no puede borrar lo aprendido con openai.
    assert.deepEqual(
      conAnthropic.providers.map((provider) => provider.id),
      ["anthropic", "openai", "opencode"],
    );
    await service.assertUsableModel("openai", "openai-tools");
    await service.assertUsableModel("anthropic", "anthropic-tools");

    // Leer no levanta contenedores: el cache esta fresco.
    corridas = 0;
    await service.get();
    await service.get();
    assert.equal(corridas, 0);
  });

  it("comparte una sola corrida entre refrescos concurrentes del mismo proveedor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "manteiner-catalog-single-"));
    directories.push(directory);
    let corridas = 0;
    const service = new ProviderCatalogService({
      runtime: {
        getCatalog: async () => {
          corridas += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return [{
            id: "openai",
            name: "OpenAI",
            models: [{ id: "gpt-tools", name: "GPT Tools", capabilities: { toolcall: true } }],
          }];
        },
        validateApiKey: async () => {},
      },
      cachePath: join(directory, "provider-catalog.json"),
      maxAgeMs: 86_400_000,
      now: () => 1_000,
    });

    const credential = { providerId: "openai", payload: { type: "api", key: "k" } as const };
    await Promise.all([
      service.refresh(credential),
      service.refresh(credential),
      service.refresh(credential),
    ]);
    assert.equal(corridas, 1);
  });

  it("sirve un cache vencido mientras el refresh falla en background", async () => {
    const directory = mkdtempSync(join(tmpdir(), "manteiner-catalog-stale-"));
    directories.push(directory);
    let now = 1_000;
    let unavailable = false;
    const service = new ProviderCatalogService({
      runtime: {
        getCatalog: async () => {
          if (unavailable) throw new Error("Docker apagado");
          return [{
            id: "openai",
            name: "OpenAI",
            models: [{ id: "gpt-tools", name: "GPT Tools", capabilities: { toolcall: true } }],
          }];
        },
        validateApiKey: async () => {},
      },
      cachePath: join(directory, "provider-catalog.json"),
      maxAgeMs: 60_000,
      now: () => now,
    });
    await service.get();
    now = 100_000;
    unavailable = true;

    const stale = await service.get();
    assert.equal(stale.providers[0]?.models[0]?.id, "gpt-tools");
    await service.close();
  });
});
