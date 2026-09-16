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
      GITHUB_APP_ID: "123456",
      GITHUB_APP_SLUG: "manteiner-test",
      GITHUB_APP_CLIENT_ID: "github-app-client-id",
      GITHUB_APP_CLIENT_SECRET: "github-app-client-secret",
      GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(githubPrivateKey).toString("base64"),
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
    let revokedGithubAppTokens = 0;
    let organizationRole: "admin" | "member" = "admin";
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
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        const rawBody = String(init?.body);
        const clientId = rawBody.startsWith("{")
          ? (JSON.parse(rawBody) as { client_id: string }).client_id
          : new URLSearchParams(rawBody).get("client_id");
        return Response.json({
          access_token:
            clientId === "github-app-client-id"
              ? "github-app-user-token"
              : "github-access-secret",
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({
          id: 583231,
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
      if (/^https:\/\/api\.github\.com\/user\/installations\/(777|888|889)\/repositories\?per_page=1$/.test(url)) {
        return Response.json({ total_count: 1, repositories: [] });
      }
      if (/^https:\/\/api\.github\.com\/app\/installations\/(777|888|889)$/.test(url)) {
        const organization = !url.endsWith("/777");
        return Response.json({
          id: url.endsWith("/889") ? 889 : organization ? 888 : 777,
          account: organization
            ? { id: 42, login: "github", type: "Organization" }
            : { id: 583231, login: "octocat", type: "User" },
          repository_selection: "selected",
          suspended_at: null,
        });
      }
      if (url === "https://api.github.com/user/memberships/orgs/github") {
        return Response.json({ state: "active", role: organizationRole });
      }
      if (/^https:\/\/api\.github\.com\/app\/installations\/(777|888)\/access_tokens$/.test(url)) {
        return Response.json(
          {
            token: url.includes("/888/") ? "installation-token-888" : "installation-token-777",
            expires_at: "2099-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      }
      if (url === "https://api.github.com/installation/repositories?per_page=100&page=1") {
        const organization = String((init?.headers as Record<string, string>)?.Authorization).endsWith(
          "installation-token-888",
        );
        return Response.json({
          total_count: 1,
          repositories: [
            {
              id: organization ? 1000 : 999,
              owner: { login: organization ? "github" : "octocat" },
              name: organization ? "project" : "hello-world",
              full_name: organization ? "github/project" : "octocat/hello-world",
              default_branch: "main",
              private: false,
              language: "TypeScript",
              html_url: "https://github.com/octocat/hello-world",
            },
          ],
        });
      }
      if (
        url === "https://api.github.com/applications/github-app-client-id/token" &&
        init?.method === "DELETE"
      ) {
        revokedGithubAppTokens += 1;
        return new Response(null, { status: 204 });
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

      const installUrl = await app.inject({
        method: "GET",
        url: "/api/github/install-url",
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(installUrl.statusCode, 200);
      const installState = new URL(installUrl.json().url).searchParams.get("state");
      assert.ok(installState);

      const setupUrl = `/api/github/setup?installation_id=777&setup_action=install&code=app-code&state=${encodeURIComponent(installState)}`;
      const setup = await app.inject({
        method: "GET",
        url: setupUrl,
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(setup.statusCode, 302);
      assert.equal(setup.headers.location, "http://localhost:5173/?github=connected");
      assert.equal(revokedGithubAppTokens, 1);

      const replay = await app.inject({
        method: "GET",
        url: setupUrl,
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(replay.statusCode, 400);
      assert.equal(replay.json().error.code, "INVALID_GITHUB_STATE");

      const organizationUrl = await app.inject({
        method: "GET",
        url: "/api/github/install-url",
        headers: { cookie: cookieHeader(cookies) },
      });
      const organizationState = new URL(organizationUrl.json().url).searchParams.get("state");
      assert.ok(organizationState);
      const organizationSetup = await app.inject({
        method: "GET",
        url: `/api/github/setup?installation_id=888&setup_action=install&code=org-code&state=${encodeURIComponent(organizationState)}`,
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(organizationSetup.statusCode, 302);
      assert.equal(revokedGithubAppTokens, 2);

      organizationRole = "member";
      const memberUrl = await app.inject({
        method: "GET",
        url: "/api/github/install-url",
        headers: { cookie: cookieHeader(cookies) },
      });
      const memberState = new URL(memberUrl.json().url).searchParams.get("state");
      assert.ok(memberState);
      const memberSetup = await app.inject({
        method: "GET",
        url: `/api/github/setup?installation_id=889&setup_action=install&code=member-code&state=${encodeURIComponent(memberState)}`,
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(memberSetup.statusCode, 403);
      assert.equal(memberSetup.json().error.code, "GITHUB_INSTALLATION_ADMIN_REQUIRED");
      assert.equal(revokedGithubAppTokens, 3);
      organizationRole = "admin";

      const available = await app.inject({
        method: "GET",
        url: "/api/github/available-repos",
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(available.statusCode, 200);
      assert.deepEqual(
        available.json().map((repository: { fullName: string }) => repository.fullName),
        ["github/project", "octocat/hello-world"],
      );

      const link = await app.inject({
        method: "POST",
        url: "/api/repos",
        headers: { cookie: cookieHeader(cookies) },
        payload: { githubRepoId: 999 },
      });
      assert.equal(link.statusCode, 201);
      assert.equal(link.json().defaultBranch, "main");

      const linkOrganizationRepository = await app.inject({
        method: "POST",
        url: "/api/repos",
        headers: { cookie: cookieHeader(cookies) },
        payload: { githubRepoId: 1000 },
      });
      assert.equal(linkOrganizationRepository.statusCode, 201);

      const repositories = await app.inject({
        method: "GET",
        url: "/api/repos",
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(repositories.statusCode, 200);
      assert.deepEqual(
        repositories.json().map((repository: { fullName: string }) => repository.fullName),
        ["github/project", "octocat/hello-world"],
      );

      const noneAvailable = await app.inject({
        method: "GET",
        url: "/api/github/available-repos",
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.deepEqual(noneAvailable.json(), []);

      const installation = app.database.sqlite
        .prepare("SELECT id FROM github_installations WHERE installation_id = 888")
        .get() as { id: string };
      app.database.sqlite
        .prepare(
          `INSERT INTO users
            (id, github_id, github_login, email_verified, created_at, updated_at)
           VALUES ('second-user', 900001, 'second-user', 0, 1, 1)`,
        )
        .run();
      app.database.sqlite
        .prepare(
          `INSERT INTO github_user_installations
            (id, user_id, installation_id, created_at, updated_at)
           VALUES ('second-relation', 'second-user', ?, 1, 1)`,
        )
        .run(installation.id);
      const installationUsers = app.database.sqlite
        .prepare("SELECT count(*) AS count FROM github_user_installations WHERE installation_id = ?")
        .get(installation.id) as { count: number };
      assert.equal(installationUsers.count, 2);

      const onboarded = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(onboarded.json().onboarding.hasInstallation, true);
      assert.equal(onboarded.json().onboarding.hasRepos, true);

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
