import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

function mergeCookies(target: Map<string, string>, setCookie: string | string[] | undefined) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator > 0) target.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

describe("servidor", () => {
  let app: FastifyInstance;
  let temporaryDirectory: string;

  before(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "manteiner-server-"));
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MASTER_KEY: randomBytes(32).toString("base64"),
      SESSION_SECRET: randomBytes(32).toString("base64"),
      GITHUB_OAUTH_CLIENT_ID: "github-client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
      DATABASE_PATH: join(temporaryDirectory, "manteiner.db"),
    } as NodeJS.ProcessEnv);
    app = buildServer(config);
  });

  after(async () => {
    await app.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
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

  it("GET /api/me exige una sesion", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });

    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "UNAUTHENTICATED");
  });

  it("inicia el OAuth de GitHub mediante Better Auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/social",
      headers: { origin: "http://localhost:5173" },
      payload: {
        provider: "github",
        callbackURL: "http://localhost:5173/",
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.redirect, true);
    assert.match(body.url, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    assert.match(body.url, /client_id=github-client-id/);
    assert.match(body.url, /scope=read%3Auser\+user%3Aemail/);
    assert.match(body.url, /state=/);
    assert.match(body.url, /code_challenge=/);
    assert.match(String(res.headers["set-cookie"]), /HttpOnly/i);
    assert.match(String(res.headers["set-cookie"]), /SameSite=Lax/i);
  });

  it("completa callback, descarta tokens, expone la sesion y permite logout", async () => {
    const cookies = new Map<string, string>();
    const start = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/social",
      headers: { origin: "http://localhost:5173" },
      payload: { provider: "github", callbackURL: "http://localhost:5173/" },
    });
    mergeCookies(cookies, start.headers["set-cookie"]);
    const state = new URL(start.json().url).searchParams.get("state");
    assert.ok(state);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "github-access-secret",
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({
          id: "583231",
          login: "octocat",
          name: "The Octocat",
          email: null,
          avatar_url: "https://avatars.githubusercontent.com/u/583231",
        });
      }
      if (url === "https://api.github.com/user/emails") {
        return Response.json([
          {
            email: "octocat@github.com",
            primary: true,
            verified: true,
            visibility: "private",
          },
        ]);
      }
      throw new Error(`Fetch inesperado: ${url}`);
    };

    try {
      const callback = await app.inject({
        method: "GET",
        url: `/api/auth/callback/github?code=test-code&state=${encodeURIComponent(state)}`,
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(callback.statusCode, 302);
      assert.equal(callback.headers.location, "http://localhost:5173/");
      mergeCookies(cookies, callback.headers["set-cookie"]);

      const account = app.database.sqlite
        .prepare(
          "SELECT account_id, access_token, refresh_token, id_token FROM accounts WHERE provider_id = 'github'",
        )
        .get() as {
        account_id: string;
        access_token: string | null;
        refresh_token: string | null;
        id_token: string | null;
      };
      assert.deepEqual(account, {
        account_id: "583231",
        access_token: null,
        refresh_token: null,
        id_token: null,
      });

      const me = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().user.githubLogin, "octocat");
      assert.deepEqual(me.json().onboarding, {
        hasProvider: false,
        hasInstallation: false,
        hasRepos: false,
      });

      const logout = await app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        headers: {
          cookie: cookieHeader(cookies),
          origin: "http://localhost:5173",
        },
      });
      assert.equal(logout.statusCode, 200);

      const sessionCount = app.database.sqlite
        .prepare("SELECT count(*) AS count FROM sessions")
        .get() as { count: number };
      assert.equal(sessionCount.count, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
