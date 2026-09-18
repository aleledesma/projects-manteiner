import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { AppError } from "../errors.ts";

/** El protocolo SSE separa campos con un salto y eventos con dos. */
const SSE_NL = String.fromCharCode(10);
const SSE_FIN = SSE_NL + SSE_NL;

const repositoryParamsSchema = z.object({ id: z.uuid() });
const runParamsSchema = z.object({ id: z.uuid() });

export function runRoutes(app: FastifyInstance): void {
  /**
   * Lanza la auditoria y responde 202 con el id. No espera a que termine: un
   * run puede durar media hora. El cliente sigue el estado con
   * `GET /api/runs/:id` hasta que la Fase 6 traiga el streaming.
   */
  app.post("/api/repos/:id/runs", async (request, reply) => {
    const userId = await requireUserId(app, request);
    const { id } = repositoryParamsSchema.parse(request.params);
    const { id: runId, finished } = await app.runs.start({ userId, repositoryId: id });
    // El fallo ya quedo registrado en la fila del run; sin este `catch` seria
    // ademas un unhandledRejection que tumba el proceso.
    finished.catch((error: unknown) => request.log.error({ err: error, runId }, "run fallido"));
    return reply.status(202).send({ id: runId, status: "preparing" });
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
                r.error_detail AS errorDetail,
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

  /**
   * Progreso en vivo del run.
   *
   * La autorizacion va por cookie porque `EventSource` no deja mandar headers
   * propios: un `runId` no es un secreto, asi que se exige la misma sesion que
   * el resto de la API (doc 07).
   */
  app.get("/api/runs/:id/events", async (request, reply) => {
    const userId = await requireUserId(app, request);
    const { id } = runParamsSchema.parse(request.params);

    const run = app.database.sqlite
      .prepare("SELECT status FROM runs WHERE id = ? AND user_id = ?")
      .get(id, userId) as { status: string } | undefined;
    if (!run) throw AppError.notFound("Run no encontrado.");

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Imprescindible si hay un nginx delante: si no, bufferea el stream entero.
      "x-accel-buffering": "no",
    });

    const escribir = (evento: { id: number; type: string; payload: unknown }) => {
      if (reply.raw.writableEnded) return;
      const lineas = evento.id > 0 ? `id: ${evento.id}${SSE_NL}` : "";
      reply.raw.write(`${lineas}event: ${evento.type}${SSE_NL}data: ${JSON.stringify(evento.payload)}${SSE_FIN}`);
    };

    // Replay primero y suscripcion despues: al reves se perderian los eventos
    // que lleguen mientras se lee la base.
    const desde = Number.parseInt(String(request.headers["last-event-id"] ?? "0"), 10);
    const pendientes = app.runEvents.replay(id, Number.isFinite(desde) ? desde : 0);
    for (const evento of pendientes) escribir(evento);

    const terminado = (tipo: string) => tipo === "run.completed" || tipo === "run.failed";
    const yaTermino = ["succeeded", "failed", "timed_out", "cancelled"].includes(run.status);

    if (yaTermino && pendientes.some((evento) => terminado(evento.type))) {
      reply.raw.end();
      return reply;
    }

    const desuscribir = app.runEvents.subscribe(id, (evento) => {
      escribir(evento);
      // El servidor cierra al terminar; si no, `EventSource` reconecta para
      // siempre contra un run que ya no va a emitir nada.
      if (terminado(evento.type)) cerrar();
    });

    // Sin esto, proxies y balanceadores cortan la conexion durante las fases
    // largas: el agente puede pasar minutos investigando sin emitir nada.
    const latido = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(`: ping${SSE_FIN}`);
    }, 15_000);

    let cerrado = false;
    function cerrar(): void {
      if (cerrado) return;
      cerrado = true;
      clearInterval(latido);
      desuscribir();
      if (!reply.raw.writableEnded) reply.raw.end();
    }

    request.raw.on("close", cerrar);
    return reply;
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
