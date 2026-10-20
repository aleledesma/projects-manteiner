import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

const githubPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

function servidor(directorio: string, extra: Record<string, string> = {}): FastifyInstance {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    MASTER_KEY: randomBytes(32).toString("base64"),
    SESSION_SECRET: randomBytes(32).toString("base64"),
    GITHUB_OAUTH_CLIENT_ID: "github-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_SLUG: "manteiner-test",
    GITHUB_APP_CLIENT_ID: "github-app-client-id",
    GITHUB_APP_CLIENT_SECRET: "github-app-client-secret",
    GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(githubPrivateKey).toString("base64"),
    DATABASE_PATH: join(directorio, "manteiner.db"),
    PROVIDER_CATALOG_PATH: join(directorio, "provider-catalog.json"),
    ...extra,
  } as NodeJS.ProcessEnv);
  return buildServer(config, {
    dockerClient: {
      ping: async () => "OK",
      version: async () =>
        ({ Version: "28.0.0", ApiVersion: "1.48", Os: "linux", Arch: "amd64" }) as never,
    },
  });
}

describe("rate limiting", () => {
  let directorio: string;
  const apps: FastifyInstance[] = [];

  before(() => {
    directorio = mkdtempSync(join(tmpdir(), "manteiner-rate-"));
  });

  after(async () => {
    for (const app of apps) await app.close();
    rmSync(directorio, { recursive: true, force: true });
  });

  it("corta con 429 RATE_LIMITED y Retry-After al pasar el limite de la ruta", async () => {
    const app = servidor(join(directorio, "a") + "-");
    apps.push(app);

    // Sin sesion responde 401, pero el intento cuenta igual: el limite corre
    // antes del handler, que es justo lo que protege del abuso.
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: "POST", url: "/api/providers/catalog/refresh" });
      assert.equal(res.statusCode, 401);
    }
    const res = await app.inject({ method: "POST", url: "/api/providers/catalog/refresh" });
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error.code, "RATE_LIMITED");
    assert.ok(Number(res.headers["retry-after"]) > 0);
  });

  it("el healthcheck no tiene limite", async () => {
    const app = servidor(join(directorio, "b") + "-");
    apps.push(app);
    for (let i = 0; i < 320; i += 1) {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      assert.equal(res.statusCode, 200);
    }
  });

  it("se puede desactivar con RATE_LIMIT_ENABLED=false", async () => {
    const app = servidor(join(directorio, "c") + "-", { RATE_LIMIT_ENABLED: "false" });
    apps.push(app);
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: "POST", url: "/api/providers/catalog/refresh" });
      assert.equal(res.statusCode, 401);
    }
  });
});
