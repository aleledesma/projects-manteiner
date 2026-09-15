import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

describe("servidor", () => {
  let app: FastifyInstance;

  before(() => {
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MASTER_KEY: randomBytes(32).toString("base64"),
      SESSION_SECRET: "y".repeat(32),
    } as NodeJS.ProcessEnv);
    app = buildServer(config);
  });

  after(async () => {
    await app.close();
  });

  it("GET /api/health responde ok", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.env, "test");
    assert.equal(body.contractSchemaVersion, "1.0");
    assert.equal(typeof body.uptimeMs, "number");
  });

  it("una ruta inexistente devuelve la forma de error uniforme", async () => {
    const res = await app.inject({ method: "GET", url: "/api/no-existe" });

    assert.equal(res.statusCode, 404);
    const body = res.json();
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(typeof body.error.message, "string");
  });
});
