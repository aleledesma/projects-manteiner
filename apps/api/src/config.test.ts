import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { ConfigError, loadConfig, masterKeyBytes } from "./config.ts";

const claveValida = randomBytes(32).toString("base64");
const secretoValido = "x".repeat(32);

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    MASTER_KEY: claveValida,
    SESSION_SECRET: secretoValido,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("loadConfig", () => {
  it("aplica los valores por defecto cuando solo estan los secretos", () => {
    const config = loadConfig(env());
    assert.equal(config.NODE_ENV, "development");
    assert.equal(config.PORT, 3001);
    assert.equal(config.LOG_LEVEL, "info");
    assert.equal(config.isProduction, false);
  });

  it("coerciona PORT de string a number", () => {
    const config = loadConfig(env({ PORT: "8080" }));
    assert.equal(config.PORT, 8080);
    assert.equal(typeof config.PORT, "number");
  });

  it("no arranca si falta MASTER_KEY", () => {
    assert.throws(() => loadConfig(env({ MASTER_KEY: undefined })), ConfigError);
  });

  it("no arranca si falta SESSION_SECRET", () => {
    assert.throws(() => loadConfig(env({ SESSION_SECRET: undefined })), ConfigError);
  });

  it("rechaza una MASTER_KEY que no sean 32 bytes", () => {
    const corta = randomBytes(16).toString("base64");
    assert.throws(() => loadConfig(env({ MASTER_KEY: corta })), ConfigError);

    const larga = randomBytes(64).toString("base64");
    assert.throws(() => loadConfig(env({ MASTER_KEY: larga })), ConfigError);
  });

  it("rechaza un SESSION_SECRET corto", () => {
    assert.throws(() => loadConfig(env({ SESSION_SECRET: "corto" })), ConfigError);
  });

  it("informa TODOS los problemas juntos, no solo el primero", () => {
    try {
      loadConfig({} as NodeJS.ProcessEnv);
      assert.fail("deberia haber lanzado");
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /MASTER_KEY/);
      assert.match(err.message, /SESSION_SECRET/);
    }
  });

  it("decodifica la clave maestra a 32 bytes", () => {
    const config = loadConfig(env());
    assert.equal(masterKeyBytes(config).length, 32);
  });

  it("devuelve un objeto congelado", () => {
    const config = loadConfig(env());
    assert.ok(Object.isFrozen(config));
  });
});
