import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { loadConfig } from "../config.ts";
import { AppError } from "../errors.ts";
import { GithubAppService } from "./github-app.ts";

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

describe("GithubAppService.createCloneToken", () => {
  it("limita el token a un repositorio y contents: read", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const service = new GithubAppService(config, async (input, init) => {
      requests.push({ input: String(input), init });
      return Response.json(
        { token: `clone-token-${requests.length}`, expires_at: "2099-01-01T00:00:00Z" },
        { status: 201 },
      );
    });

    assert.equal(await service.createCloneToken(777, 999), "clone-token-1");
    assert.equal(await service.createCloneToken(777, 999), "clone-token-2");
    assert.equal(requests.length, 2, "los tokens de clon no se cachean ni persisten");

    for (const request of requests) {
      assert.equal(request.input, "https://api.github.com/app/installations/777/access_tokens");
      assert.equal(request.init?.method, "POST");
      assert.deepEqual(JSON.parse(String(request.init?.body)), {
        repository_ids: [999],
        permissions: { contents: "read" },
      });
      const headers = request.init?.headers as Record<string, string>;
      assert.ok(headers.Authorization);
      assert.match(headers.Authorization, /^Bearer eyJ/);
      assert.equal(headers["Content-Type"], "application/json");
    }
  });

  it("convierte el rechazo de GitHub en un error de la aplicacion", async () => {
    const service = new GithubAppService(config, async () =>
      Response.json({ message: "Forbidden" }, { status: 403 }),
    );

    await assert.rejects(
      () => service.createCloneToken(777, 999),
      (error: unknown) => error instanceof AppError && error.code === "GITHUB_API_ERROR",
    );
  });
});

describe("GithubAppService.getRepositoryForClone", () => {
  it("consulta por ID el tamaño y las coordenadas autorizadas", async () => {
    let request: { input: string; init?: RequestInit } | undefined;
    const service = new GithubAppService(config, async (input, init) => {
      request = { input: String(input), init };
      return Response.json({
        id: 999,
        owner: { login: "octocat" },
        name: "hello-world",
        default_branch: "main",
        size: 12_345,
      });
    });

    assert.deepEqual(await service.getRepositoryForClone("clone-token", 999), {
      id: 999,
      owner: { login: "octocat" },
      name: "hello-world",
      default_branch: "main",
      size: 12_345,
    });
    assert.equal(request?.input, "https://api.github.com/repositories/999");
    assert.equal(
      (request?.init?.headers as Record<string, string>).Authorization,
      "Bearer clone-token",
    );
  });

  it("trata una respuesta malformada como error de GitHub", async () => {
    const service = new GithubAppService(config, async () => Response.json({ size: "unknown" }));
    await assert.rejects(
      () => service.getRepositoryForClone("clone-token", 999),
      (error: unknown) => error instanceof AppError && error.code === "GITHUB_API_ERROR",
    );
  });
});

describe("GithubAppService.revokeInstallationToken", () => {
  it("revoca el token de instalacion al terminar", async () => {
    let request: { input: string; init?: RequestInit } | undefined;
    const service = new GithubAppService(config, async (input, init) => {
      request = { input: String(input), init };
      return new Response(null, { status: 204 });
    });

    await service.revokeInstallationToken("clone-token");
    assert.equal(request?.input, "https://api.github.com/installation/token");
    assert.equal(request?.init?.method, "DELETE");
    assert.equal(
      (request?.init?.headers as Record<string, string>).Authorization,
      "Bearer clone-token",
    );
  });
});
