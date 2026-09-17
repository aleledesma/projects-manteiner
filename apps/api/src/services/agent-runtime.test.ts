import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import { loadConfig } from "../config.ts";
import {
  timeoutDeTransporte,
  UNDICI_HEADERS_TIMEOUT_POR_DEFECTO_MS,
} from "./agent-runtime.ts";

/**
 * Regresion de un fallo real: tres auditorias murieron con "fetch failed" a los
 * ~311s. El `fetch` de Node aborta una respuesta cuyas cabeceras tardan mas de
 * 300s, y la sesion del agente tarda exactamente eso, porque opencode mantiene
 * el pedido abierto mientras el modelo trabaja. Quien tiene que cortar es
 * RUN_TIMEOUT_MS, nunca el transporte.
 */
describe("timeout de transporte del agente", () => {
  it("supera el default de undici con el RUN_TIMEOUT_MS por defecto", () => {
    const llave = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;

    const config = loadConfig({
      MASTER_KEY: Buffer.alloc(32).toString("base64"),
      SESSION_SECRET: "x".repeat(32),
      GITHUB_OAUTH_CLIENT_ID: "id",
      GITHUB_OAUTH_CLIENT_SECRET: "secret",
      GITHUB_APP_ID: "1",
      GITHUB_APP_SLUG: "app",
      GITHUB_APP_CLIENT_ID: "id",
      GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(llave).toString("base64"),
    });

    assert.ok(
      timeoutDeTransporte(config.RUN_TIMEOUT_MS) > UNDICI_HEADERS_TIMEOUT_POR_DEFECTO_MS,
      "el transporte cortaria antes de que el agente pueda terminar",
    );
  });

  it("deja margen por encima del run, no por debajo", () => {
    for (const runTimeout of [60_000, 600_000, 30 * 60_000]) {
      assert.ok(
        timeoutDeTransporte(runTimeout) > runTimeout,
        `el transporte no puede cortar antes que RUN_TIMEOUT_MS=${runTimeout}`,
      );
    }
  });
});
