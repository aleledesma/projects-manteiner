import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { AppError } from "../errors.ts";

const repositoryParamsSchema = z.object({ id: z.uuid() });
const runParamsSchema = z.object({ id: z.uuid() });

export function runRoutes(app: FastifyInstance): void {
  /**
   * Corre la auditoria completa y responde cuando termino. Sin streaming
   * todavia: eso es la Fase 6. El cliente tiene que tolerar una espera larga,
   * acotada por RUN_TIMEOUT_MS.
   */
  app.post("/api/repos/:id/runs", async (request, reply) => {
    const userId = await requireUserId(app, request);
    const { id } = repositoryParamsSchema.parse(request.params);
    const run = await app.runs.start({ userId, repositoryId: id });
    return reply.status(run.status === "succeeded" ? 201 : 200).send(run);
  });

  app.get("/api/runs/:id", async (request) => {
    const userId = await requireUserId(app, request);
    const { id } = runParamsSchema.parse(request.params);

    const run = app.database.sqlite
      .prepare(
        `SELECT r.id, r.repository_id AS repositoryId, repo.full_name AS repositoryFullName,
                r.audit_type AS auditType, r.status, r.provider_id AS providerId,
                r.model_id AS modelId, r.agent_version AS agentVersion,
                r.schema_version AS schemaVersion, r.commit_sha AS commitSha,
                r.base_branch AS baseBranch, r.health_score AS healthScore,
                r.findings_count AS findingsCount, r.headline,
                r.error_code AS errorCode, r.error_message AS errorMessage,
                r.tokens_input AS tokensInput, r.tokens_output AS tokensOutput,
                r.cost_usd AS costUsd, r.queued_at AS queuedAt,
                r.started_at AS startedAt, r.finished_at AS finishedAt,
                r.duration_ms AS durationMs, r.result_json AS resultJson
         FROM runs r
         INNER JOIN repositories repo ON repo.id = r.repository_id
         WHERE r.id = ? AND r.user_id = ?`,
      )
      .get(id, userId) as (Record<string, unknown> & { resultJson: string | null }) | undefined;
    if (!run) throw AppError.notFound("Run no encontrado.");

    const { resultJson, ...resto } = run;
    return { ...resto, result: resultJson ? JSON.parse(resultJson) : null };
  });

  app.get("/api/repos/:id/runs", async (request) => {
    const userId = await requireUserId(app, request);
    const { id } = repositoryParamsSchema.parse(request.params);
    return app.database.sqlite
      .prepare(
        `SELECT id, status, health_score AS healthScore, findings_count AS findingsCount,
                headline, error_code AS errorCode, queued_at AS queuedAt,
                finished_at AS finishedAt, duration_ms AS durationMs
         FROM runs
         WHERE repository_id = ? AND user_id = ?
         ORDER BY queued_at DESC
         LIMIT 50`,
      )
      .all(id, userId);
  });
}

async function requireUserId(app: FastifyInstance, request: FastifyRequest): Promise<string> {
  const session = await app.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) throw AppError.unauthorized();
  return session.user.id;
}
