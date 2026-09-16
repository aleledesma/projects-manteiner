import { createHash, randomBytes, randomUUID } from "node:crypto";

import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { AppError } from "../errors.ts";
import type { GithubRepository } from "../services/github-app.ts";

const STATE_TTL_MS = 10 * 60_000;

const setupQuerySchema = z.object({
  installation_id: z.coerce.number().int().positive(),
  setup_action: z.enum(["install", "update"]),
  state: z.string().min(20),
  code: z.string().min(1),
});

const linkRepositorySchema = z.object({
  githubRepoId: z.number().int().positive(),
});

interface AccessibleRepository extends GithubRepository {
  installationDbId: string;
  installationId: number;
}

export function githubRoutes(app: FastifyInstance): void {
  app.get("/api/github/install-url", async (request) => {
    const userId = await requireUserId(app, request);
    const now = Date.now();
    const state = randomBytes(32).toString("base64url");
    const stateHash = hashState(state);

    app.database.sqlite.prepare("DELETE FROM github_install_states WHERE expires_at <= ?").run(now);
    app.database.sqlite
      .prepare(
        "INSERT INTO github_install_states (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(stateHash, userId, now + STATE_TTL_MS, now);

    return { url: app.githubApp.installationUrl(state) };
  });

  app.get("/api/github/setup", async (request, reply) => {
    const userId = await requireUserId(app, request);
    const query = setupQuerySchema.parse(request.query);
    consumeInstallState(app, query.state, userId);

    const userToken = await app.githubApp.exchangeUserCode(query.code);
    let installation: Awaited<ReturnType<typeof app.githubApp.getInstallation>>;
    try {
      const localUser = app.database.sqlite
        .prepare("SELECT github_id FROM users WHERE id = ?")
        .get(userId) as { github_id: number } | undefined;
      const githubUserId = await app.githubApp.getAuthenticatedUserId(userToken);
      if (!localUser || githubUserId !== localUser.github_id) {
        throw new AppError(
          "GITHUB_ACCOUNT_MISMATCH",
          "La cuenta que autorizo la GitHub App no coincide con la sesion actual.",
          403,
        );
      }

      if (!(await app.githubApp.userCanAccessInstallation(userToken, query.installation_id))) {
        throw new AppError(
          "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
          "La instalacion no pertenece al usuario autenticado.",
          403,
        );
      }

      installation = await app.githubApp.getInstallation(query.installation_id);
      const ownsAccount =
        installation.account.type === "User"
          ? installation.account.id === githubUserId
          : await app.githubApp.userIsOrganizationAdmin(userToken, installation.account.login);
      if (!ownsAccount) {
        throw new AppError(
          "GITHUB_INSTALLATION_ADMIN_REQUIRED",
          "Solo el propietario o un administrador puede vincular la instalacion.",
          403,
        );
      }
    } finally {
      await app.githubApp.revokeUserToken(userToken);
    }

    const saveInstallation = app.database.sqlite.transaction(() => {
      const existing = app.database.sqlite
        .prepare("SELECT id FROM github_installations WHERE installation_id = ?")
        .get(query.installation_id) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();
      const now = Date.now();
      app.database.sqlite
        .prepare(
          `INSERT INTO github_installations
            (id, installation_id, account_login, account_type, repository_selection, suspended_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET
             account_login = excluded.account_login,
             account_type = excluded.account_type,
             repository_selection = excluded.repository_selection,
             suspended_at = excluded.suspended_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          id,
          installation.id,
          installation.account.login,
          installation.account.type,
          installation.repository_selection,
          installation.suspended_at ? Date.parse(installation.suspended_at) : null,
          now,
          now,
        );

      app.database.sqlite
        .prepare(
          `INSERT INTO github_user_installations (id, user_id, installation_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, installation_id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(randomUUID(), userId, id, now, now);
    });
    saveInstallation();

    return reply.redirect(`${app.config.WEB_URL}/?github=connected`);
  });

  app.get("/api/github/available-repos", async (request) => {
    const userId = await requireUserId(app, request);
    const accessible = await accessibleRepositories(app, userId);
    const linkedRows = app.database.sqlite
      .prepare("SELECT github_repo_id FROM repositories WHERE user_id = ? AND unlinked_at IS NULL")
      .all(userId) as Array<{ github_repo_id: number }>;
    const linked = new Set(linkedRows.map((row) => row.github_repo_id));
    return accessible.filter((repository) => !linked.has(repository.id)).map(repositoryBody);
  });

  app.post("/api/repos", async (request, reply) => {
    const userId = await requireUserId(app, request);
    const { githubRepoId } = linkRepositorySchema.parse(request.body);
    const repository = (await accessibleRepositories(app, userId)).find(
      (candidate) => candidate.id === githubRepoId,
    );
    if (!repository) throw AppError.notFound("Repositorio no disponible para vincular.");

    const now = Date.now();
    app.database.sqlite
      .prepare(
        `INSERT INTO repositories
          (id, user_id, installation_id, github_repo_id, owner, name, full_name, default_branch, private, primary_language, html_url, linked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, github_repo_id) DO UPDATE SET
           installation_id = excluded.installation_id,
           owner = excluded.owner,
           name = excluded.name,
           full_name = excluded.full_name,
           default_branch = excluded.default_branch,
           private = excluded.private,
           primary_language = excluded.primary_language,
           html_url = excluded.html_url,
           linked_at = excluded.linked_at,
           unlinked_at = NULL`,
      )
      .run(
        randomUUID(),
        userId,
        repository.installationDbId,
        repository.id,
        repository.owner.login,
        repository.name,
        repository.full_name,
        repository.default_branch,
        repository.private ? 1 : 0,
        repository.language,
        repository.html_url,
        now,
      );

    const linked = repositoryBody(repository);
    return reply.status(201).send(linked);
  });

  app.get("/api/repos", async (request) => {
    const userId = await requireUserId(app, request);
    return app.database.sqlite
      .prepare(
        `SELECT id, github_repo_id AS githubRepoId, owner, name, full_name AS fullName,
                default_branch AS defaultBranch, private, primary_language AS primaryLanguage,
                html_url AS htmlUrl, linked_at AS linkedAt
         FROM repositories
         WHERE user_id = ? AND unlinked_at IS NULL
         ORDER BY full_name`,
      )
      .all(userId)
      .map((row) => ({
        ...(row as Record<string, unknown>),
        private: (row as { private: number }).private === 1,
      }));
  });
}

async function requireUserId(app: FastifyInstance, request: FastifyRequest): Promise<string> {
  const session = await app.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) throw AppError.unauthorized();
  return session.user.id;
}

function consumeInstallState(app: FastifyInstance, state: string, userId: string): void {
  const stateHash = hashState(state);
  const consume = app.database.sqlite.transaction(() => {
    const row = app.database.sqlite
      .prepare("SELECT user_id, expires_at FROM github_install_states WHERE id = ?")
      .get(stateHash) as { user_id: string; expires_at: number } | undefined;
    app.database.sqlite.prepare("DELETE FROM github_install_states WHERE id = ?").run(stateHash);
    return row;
  });
  const row = consume();
  if (!row || row.user_id !== userId || row.expires_at <= Date.now()) {
    throw new AppError("INVALID_GITHUB_STATE", "El estado de instalacion es invalido o vencio.");
  }
}

async function accessibleRepositories(
  app: FastifyInstance,
  userId: string,
): Promise<AccessibleRepository[]> {
  const installations = app.database.sqlite
    .prepare(
      `SELECT gi.id, gi.installation_id
       FROM github_installations gi
       INNER JOIN github_user_installations gui ON gui.installation_id = gi.id
       WHERE gui.user_id = ? AND gi.suspended_at IS NULL`,
    )
    .all(userId) as Array<{ id: string; installation_id: number }>;
  const byGithubId = new Map<number, AccessibleRepository>();

  for (const installation of installations) {
    const repositories = await app.githubApp.listInstallationRepositories(installation.installation_id);
    for (const repository of repositories) {
      byGithubId.set(repository.id, {
        ...repository,
        installationDbId: installation.id,
        installationId: installation.installation_id,
      });
    }
  }

  return [...byGithubId.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
}

function repositoryBody(repository: AccessibleRepository) {
  return {
    githubRepoId: repository.id,
    installationId: repository.installationId,
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    private: repository.private,
    primaryLanguage: repository.language,
    htmlUrl: repository.html_url,
  };
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}
