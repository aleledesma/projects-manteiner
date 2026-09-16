import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import type Dockerode from "dockerode";

import { loadConfig } from "../config.ts";
import { AppError } from "../errors.ts";
import { DockerService, type DockerClient } from "./docker.ts";

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const config = loadConfig({
  NODE_ENV: "test",
  MASTER_KEY: randomBytes(32).toString("base64"),
  SESSION_SECRET: randomBytes(32).toString("base64"),
  GITHUB_OAUTH_CLIENT_ID: "github-client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "manteiner-test",
  GITHUB_APP_CLIENT_ID: "github-app-client-id",
  GITHUB_APP_CLIENT_SECRET: "github-app-client-secret",
  GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString("base64"),
} as NodeJS.ProcessEnv);

function version(): Dockerode.DockerVersion {
  return {
    Version: "28.0.0",
    ApiVersion: "1.48",
    Os: "linux",
    Arch: "amd64",
  } as Dockerode.DockerVersion;
}

describe("DockerService", () => {
  it("informa la version cuando el daemon responde", async () => {
    const client: DockerClient = {
      ping: async () => "OK",
      version: async () => version(),
    };

    assert.deepEqual(await new DockerService(config, client).status(), {
      available: true,
      version: "28.0.0",
      apiVersion: "1.48",
      os: "linux",
      architecture: "amd64",
    });
  });

  it("informa unavailable sin impedir que arranque la API", async () => {
    const client: DockerClient = {
      ping: async () => {
        throw new Error("daemon apagado");
      },
      version: async () => version(),
    };

    const service = new DockerService(config, client);
    assert.deepEqual(await service.status(), { available: false });
    await assert.rejects(
      () => service.requireAvailable(),
      (error: unknown) => error instanceof AppError && error.code === "DOCKER_UNAVAILABLE",
    );
  });

  it("aplica un deadline total aunque el cliente no responda", async () => {
    const pending = new Promise<never>(() => undefined);
    const client: DockerClient = {
      ping: () => pending,
      version: () => pending,
    };
    const startedAt = Date.now();

    const status = await new DockerService(
      { ...config, DOCKER_API_TIMEOUT_MS: 100 },
      client,
    ).status();

    assert.deepEqual(status, { available: false });
    assert.ok(Date.now() - startedAt < 1_000);
  });
});
