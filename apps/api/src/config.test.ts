import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { ConfigError, githubAppPrivateKeyBytes, loadConfig, masterKeyBytes } from "./config.ts";

const claveValida = randomBytes(32).toString("base64");
const secretoValido = "x".repeat(32);
const githubPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    MASTER_KEY: claveValida,
    SESSION_SECRET: secretoValido,
    GITHUB_OAUTH_CLIENT_ID: "github-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_SLUG: "manteiner-test",
    GITHUB_APP_CLIENT_ID: "github-app-client-id",
    GITHUB_APP_CLIENT_SECRET: "github-app-client-secret",
    GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(githubPrivateKey).toString("base64"),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("loadConfig", () => {
  it("aplica los valores por defecto cuando solo estan los secretos", () => {
    const config = loadConfig(env());
    assert.equal(config.NODE_ENV, "development");
    assert.equal(config.PORT, 3001);
    assert.equal(config.LOG_LEVEL, "info");
    assert.equal(config.DOCKER_SOCKET, undefined);
    assert.equal(config.DOCKER_API_TIMEOUT_MS, 3_000);
    assert.equal(config.GIT_IMAGE, "manteiner-git:0.1.0");
    assert.equal(config.MAX_REPO_SIZE_KB, 2_000_000);
    assert.equal(config.CLONE_TIMEOUT_MS, 300_000);
    assert.equal(config.isProduction, false);
  });

  it("coerciona PORT de string a number", () => {
    const config = loadConfig(env({ PORT: "8080" }));
    assert.equal(config.PORT, 8080);
    assert.equal(typeof config.PORT, "number");
  });

  it("valida la configuracion de Docker", () => {
    const config = loadConfig(
      env({
        DOCKER_SOCKET: "/custom/docker.sock",
        DOCKER_API_TIMEOUT_MS: "5000",
        GIT_IMAGE: "custom-git:1.2.3",
        MAX_REPO_SIZE_KB: "1000",
        CLONE_TIMEOUT_MS: "15000",
      }),
    );
    assert.equal(config.DOCKER_SOCKET, "/custom/docker.sock");
    assert.equal(config.DOCKER_API_TIMEOUT_MS, 5_000);
    assert.equal(config.GIT_IMAGE, "custom-git:1.2.3");
    assert.equal(config.MAX_REPO_SIZE_KB, 1_000);
    assert.equal(config.CLONE_TIMEOUT_MS, 15_000);
    assert.throws(() => loadConfig(env({ DOCKER_API_TIMEOUT_MS: "0" })), ConfigError);
    assert.throws(() => loadConfig(env({ GIT_IMAGE: "   " })), ConfigError);
    assert.throws(() => loadConfig(env({ MAX_REPO_SIZE_KB: "0" })), ConfigError);
    assert.throws(() => loadConfig(env({ CLONE_TIMEOUT_MS: "999" })), ConfigError);
  });

  it("no arranca si falta MASTER_KEY", () => {
    assert.throws(() => loadConfig(env({ MASTER_KEY: undefined })), ConfigError);
  });

  it("no arranca si falta SESSION_SECRET", () => {
    assert.throws(() => loadConfig(env({ SESSION_SECRET: undefined })), ConfigError);
  });

  it("no arranca si faltan las credenciales OAuth de GitHub", () => {
    assert.throws(() => loadConfig(env({ GITHUB_OAUTH_CLIENT_ID: undefined })), ConfigError);
    assert.throws(() => loadConfig(env({ GITHUB_OAUTH_CLIENT_SECRET: undefined })), ConfigError);
  });

  it("no arranca si falta o es invalida la configuracion de GitHub App", () => {
    assert.throws(() => loadConfig(env({ GITHUB_APP_ID: undefined })), ConfigError);
    assert.throws(() => loadConfig(env({ GITHUB_APP_SLUG: "Slug Invalido" })), ConfigError);
    assert.throws(
      () => loadConfig(env({ GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from("no-es-pem").toString("base64") })),
      ConfigError,
    );
  });

  it("rechaza una MASTER_KEY que no sean 32 bytes", () => {
    const corta = randomBytes(16).toString("base64");
    assert.throws(() => loadConfig(env({ MASTER_KEY: corta })), ConfigError);

    const larga = randomBytes(64).toString("base64");
    assert.throws(() => loadConfig(env({ MASTER_KEY: larga })), ConfigError);
  });

  it("rechaza base64 malformado aunque decodifique a 32 bytes", () => {
    assert.throws(() => loadConfig(env({ MASTER_KEY: `${claveValida}!` })), ConfigError);
    assert.throws(() => loadConfig(env({ MASTER_KEY: claveValida.slice(0, -1) })), ConfigError);
  });

  it("rechaza un SESSION_SECRET corto", () => {
    assert.throws(() => loadConfig(env({ SESSION_SECRET: "corto" })), ConfigError);
  });

  it("exige un unico origen publico en produccion", () => {
    assert.throws(
      () =>
        loadConfig(
          env({
            NODE_ENV: "production",
            PUBLIC_URL: "https://api.manteiner.example",
            WEB_URL: "https://manteiner.example",
          }),
        ),
      ConfigError,
    );

    const config = loadConfig(
      env({
        NODE_ENV: "production",
        PUBLIC_URL: "https://manteiner.example",
        WEB_URL: "https://manteiner.example",
      }),
    );
    assert.equal(config.isProduction, true);
  });

  it("informa TODOS los problemas juntos, no solo el primero", () => {
    try {
      loadConfig({} as NodeJS.ProcessEnv);
      assert.fail("deberia haber lanzado");
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /MASTER_KEY/);
      assert.match(err.message, /SESSION_SECRET/);
      assert.match(err.message, /GITHUB_OAUTH_CLIENT_ID/);
      assert.match(err.message, /GITHUB_OAUTH_CLIENT_SECRET/);
      assert.match(err.message, /GITHUB_APP_ID/);
      assert.match(err.message, /GITHUB_APP_PRIVATE_KEY_BASE64/);
    }
  });

  it("decodifica la clave maestra a 32 bytes", () => {
    const config = loadConfig(env());
    assert.equal(masterKeyBytes(config).length, 32);
  });

  it("decodifica la private key de GitHub App", () => {
    const config = loadConfig(env());
    assert.match(githubAppPrivateKeyBytes(config).toString("utf8"), /BEGIN PRIVATE KEY/);
  });

  it("devuelve un objeto congelado", () => {
    const config = loadConfig(env());
    assert.ok(Object.isFrozen(config));
  });
});
