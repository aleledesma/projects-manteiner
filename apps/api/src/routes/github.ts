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

let repositorySyncQueue = Promise.resolve();

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

  /**
   * Instalaciones de la App alcanzables por el usuario, con cuantos repos ve
   * cada una y cuantos tiene vinculados. Sincroniza primero: si la instalacion
   * fue borrada o suspendida en GitHub, la vista tiene que decirlo.
   */
  app.get("/api/github/installations", async (request) => {
    const userId = await requireUserId(app, request);
    const accesibles = await syncLinkedRepositories(app, userId);

    const accesiblesPorInstalacion = new Map<string, number>();
    for (const repository of accesibles) {
      accesiblesPorInstalacion.set(
        repository.installationDbId,
        (accesiblesPorInstalacion.get(repository.installationDbId) ?? 0) + 1,
      );
    }

    const rows = app.database.sqlite
      .prepare(
        `SELECT gi.id, gi.installation_id AS installationId, gi.account_login AS accountLogin,
                gi.account_type AS accountType, gi.repository_selection AS repositorySelection,
                gi.suspended_at AS suspendedAt,
                (SELECT count(*) FROM repositories r
                  WHERE r.installation_id = gi.id AND r.user_id = ? AND r.unlinked_at IS NULL) AS linkedRepos
         FROM github_installations gi
         INNER JOIN github_user_installations gui ON gui.installation_id = gi.id
         WHERE gui.user_id = ?
         ORDER BY gi.account_type, gi.account_login`,
      )
      .all(userId, userId) as Array<Record<string, unknown> & { id: string; suspendedAt: number | null }>;

    return rows.map((row) => ({
      ...row,
      suspended: row.suspendedAt !== null,
      accessibleRepos: accesiblesPorInstalacion.get(row.id) ?? 0,
    }));
  });

  app.get("/api/github/available-repos", async (request) => {
    const userId = await requireUserId(app, request);
    const accessible = await syncLinkedRepositories(app, userId);
    const linkedRows = app.database.sqlite
      .prepare("SELECT github_repo_id FROM repositories WHERE user_id = ? AND unlinked_at IS NULL")
      .all(userId) as Array<{ github_repo_id: number }>;
    const linked = new Set(linkedRows.map((row) => row.github_repo_id));
    return accessible.filter((repository) => !linked.has(repository.id)).map(repositoryBody);
  });

  app.post("/api/repos", async (request, reply) => {
    const userId = await requireUserId(app, request);
    const { githubRepoId } = linkRepositorySchema.parse(request.body);
    const repository = (await syncLinkedRepositories(app, userId)).find(
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
    await syncLinkedRepositories(app, userId);
    // El resumen del ultimo run viaja con el repositorio: el dashboard necesita
    // uno por tarjeta, y pedirlos de a uno seria N+1 contra la misma tabla.
    return app.database.sqlite
      .prepare(
        `SELECT r.id, r.github_repo_id AS githubRepoId, r.owner, r.name,
                 r.full_name AS fullName, r.default_branch AS defaultBranch, r.private,
                 r.primary_language AS primaryLanguage, r.html_url AS htmlUrl,
                 r.linked_at AS linkedAt,
                 ultimo.id AS lastRunId, ultimo.status AS lastRunStatus,
                 ultimo.health_score AS lastRunHealthScore, ultimo.headline AS lastRunHeadline,
                 ultimo.findings_count AS lastRunFindingsCount, ultimo.model_id AS lastRunModelId,
                 ultimo.error_code AS lastRunErrorCode, ultimo.queued_at AS lastRunQueuedAt,
                 ultimo.finished_at AS lastRunFinishedAt,
                 ultimo.pr_number AS lastRunPrNumber, ultimo.pr_url AS lastRunPrUrl,
                 (SELECT count(*) FROM run_findings f
                   WHERE f.run_id = ultimo.id AND f.severity = 'high') AS lastRunHigh,
                 (SELECT count(*) FROM run_findings f
                   WHERE f.run_id = ultimo.id AND f.severity = 'medium') AS lastRunMedium,
                 (SELECT count(*) FROM run_findings f
                   WHERE f.run_id = ultimo.id AND f.severity = 'low') AS lastRunLow,
                 (SELECT count(*) FROM run_findings f
                   WHERE f.run_id = ultimo.id AND f.severity = 'info') AS lastRunInfo
          FROM repositories r
          INNER JOIN github_installations gi ON gi.id = r.installation_id
          LEFT JOIN runs ultimo ON ultimo.id = (
            SELECT id FROM runs
            WHERE repository_id = r.id AND user_id = r.user_id
            ORDER BY queued_at DESC LIMIT 1
          )
          WHERE r.user_id = ? AND r.unlinked_at IS NULL
            AND gi.suspended_at IS NULL
          ORDER BY r.full_name`,
      )
      .all(userId)
      .map((fila) => {
        const row = fila as Record<string, unknown>;
        const lastRunId = row["lastRunId"] as string | null;
        const conteo = (clave: string) => (lastRunId ? (row[clave] as number) : 0);
        return {
          id: row["id"],
          githubRepoId: row["githubRepoId"],
          owner: row["owner"],
          name: row["name"],
          fullName: row["fullName"],
          defaultBranch: row["defaultBranch"],
          private: row["private"] === 1,
          primaryLanguage: row["primaryLanguage"],
          htmlUrl: row["htmlUrl"],
          linkedAt: row["linkedAt"],
          lastRun: lastRunId
            ? {
                id: lastRunId,
                status: row["lastRunStatus"],
                healthScore: row["lastRunHealthScore"],
                headline: row["lastRunHeadline"],
                findingsCount: row["lastRunFindingsCount"],
                modelId: row["lastRunModelId"],
                errorCode: row["lastRunErrorCode"],
                queuedAt: row["lastRunQueuedAt"],
                finishedAt: row["lastRunFinishedAt"],
                prNumber: row["lastRunPrNumber"],
                prUrl: row["lastRunPrUrl"],
                severities: {
                  high: conteo("lastRunHigh"),
                  medium: conteo("lastRunMedium"),
                  low: conteo("lastRunLow"),
                  info: conteo("lastRunInfo"),
                },
              }
            : null,
        };
      });
  });
}

interface InstallationRow {
  id: string;
  installationId: number;
}

export async function syncLinkedRepositories(
  app: FastifyInstance,
  userId: string,
): Promise<AccessibleRepository[]> {
  const previous = repositorySyncQueue;
  let release!: () => void;
  repositorySyncQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await performRepositorySync(app, userId);
  } finally {
    release();
  }
}

async function performRepositorySync(
  app: FastifyInstance,
  userId: string,
): Promise<AccessibleRepository[]> {
  const installations = app.database.sqlite
    .prepare(
      `SELECT gi.id, gi.installation_id AS installationId
       FROM github_installations gi
       INNER JOIN github_user_installations gui ON gui.installation_id = gi.id
       WHERE gui.user_id = ?`,
    )
    .all(userId) as InstallationRow[];

  const snapshots = await Promise.all(
    installations.map(async (local) => {
      const installation = await app.githubApp.getInstallationIfExists(local.installationId);
      const repositories =
        installation && !installation.suspended_at
          ? await app.githubApp.listInstallationRepositories(local.installationId, { refresh: true })
          : [];
      return { local, installation, repositories };
    }),
  );

  const now = Date.now();
  app.database.sqlite.transaction(() => {
    for (const snapshot of snapshots) {
      const { local, installation, repositories } = snapshot;
      if (!installation) {
        app.database.sqlite
          .prepare(
            "UPDATE github_installations SET suspended_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(now, now, local.id);
        app.database.sqlite
          .prepare("DELETE FROM github_user_installations WHERE installation_id = ?")
          .run(local.id);
        app.database.sqlite
          .prepare(
            `UPDATE repositories
             SET unlinked_at = COALESCE(unlinked_at, ?)
             WHERE installation_id = ?`,
          )
          .run(now, local.id);
        continue;
      }

      app.database.sqlite
        .prepare(
          `UPDATE github_installations
           SET account_login = ?, account_type = ?, repository_selection = ?,
               suspended_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          installation.account.login,
          installation.account.type,
          installation.repository_selection,
          installation.suspended_at ? Date.parse(installation.suspended_at) : null,
          now,
          local.id,
        );

      if (installation.suspended_at) continue;
      const accessibleById = new Map(repositories.map((repository) => [repository.id, repository]));
      const linked = app.database.sqlite
        .prepare(
          `SELECT id, github_repo_id AS githubRepoId
           FROM repositories
           WHERE installation_id = ? AND unlinked_at IS NULL`,
        )
        .all(local.id) as Array<{ id: string; githubRepoId: number }>;

      for (const row of linked) {
        const repository = accessibleById.get(row.githubRepoId);
        if (!repository) {
          app.database.sqlite
            .prepare("UPDATE repositories SET unlinked_at = ? WHERE id = ?")
            .run(now, row.id);
          continue;
        }
        app.database.sqlite
          .prepare(
            `UPDATE repositories
             SET owner = ?, name = ?, full_name = ?, default_branch = ?, private = ?,
                 primary_language = ?, html_url = ?
             WHERE id = ?`,
          )
          .run(
            repository.owner.login,
            repository.name,
            repository.full_name,
            repository.default_branch,
            repository.private ? 1 : 0,
            repository.language,
            repository.html_url,
            row.id,
          );
      }
    }
  })();

  const accessibleById = new Map<number, AccessibleRepository>();
  for (const { local, installation, repositories } of snapshots) {
    if (!installation || installation.suspended_at) continue;
    for (const repository of repositories) {
      accessibleById.set(repository.id, {
        ...repository,
        installationDbId: local.id,
        installationId: local.installationId,
      });
    }
  }
  return [...accessibleById.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
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
