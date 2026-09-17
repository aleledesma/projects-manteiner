/**
 * Orquestador del run: clonar, auditar, validar y persistir.
 *
 * El volumen y los contenedores se destruyen siempre, por el `finally` de
 * `withClonedRepository`, haya terminado bien, mal, por timeout o por
 * cancelacion. Esa garantia es la razon de ser de todo el diseno (doc 05).
 *
 * La publicacion del PR no esta aca: es la Fase 7.
 */

import { randomUUID } from "node:crypto";

import {
  AGENT_VERSION,
  SCHEMA_VERSION,
  maintenanceReportSchema,
  normalizeReport,
  type MaintenanceReport,
} from "@manteiner/contracts";

import type { DatabaseConnection } from "../db/client.ts";
import { AppError } from "../errors.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import type { ProviderCredentialService } from "./provider-credentials.ts";
import type { RepositoryWorkspaceService } from "./repository-workspace.ts";

/** Lo minimo que el orquestador necesita del logger de Fastify. */
export interface RunLogger {
  error(contexto: Record<string, unknown>, mensaje: string): void;
}

export interface StartRunInput {
  readonly userId: string;
  readonly repositoryId: string;
  readonly auditType?: string;
}

export interface RunRow {
  id: string;
  status: string;
  errorCode: string | null;
}

interface RepositoryRow {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  githubRepoId: number;
  installationId: number;
}

interface PreferenceRow {
  provider_id: string;
  model_id: string;
}

export class RunOrchestratorService {
  /** Runs vivos en este proceso, para poder esperarlos al apagar. */
  readonly #enCurso = new Map<string, Promise<RunRow>>();

  constructor(
    private readonly database: DatabaseConnection,
    private readonly workspaces: RepositoryWorkspaceService,
    private readonly agent: AgentRuntime,
    private readonly credentials: ProviderCredentialService,
    private readonly now: () => number = Date.now,
    private readonly logger: RunLogger = { error: () => {} },
  ) {}

  /**
   * Crea el run y lo lanza. Devuelve el id apenas la fila existe, sin esperar a
   * que termine: una auditoria puede durar media hora y dejar un fetch colgado
   * todo ese tiempo es fragil. El cliente sigue el estado por `GET /api/runs/:id`
   * hasta que la Fase 6 traiga el streaming.
   *
   * `finished` queda expuesto para los tests y para el apagado ordenado.
   */
  async start(input: StartRunInput): Promise<{ id: string; finished: Promise<RunRow> }> {
    const repository = this.#buscarRepositorio(input.userId, input.repositoryId);
    const preferencia = this.#buscarPreferencia(input.userId, input.repositoryId);
    // Se resuelve antes de crear el run: fallar antes de insertar da un mensaje
    // util, fallar a mitad del clon obliga a interpretar un run muerto.
    const credential = await this.credentials.getUsable(input.userId, preferencia.provider_id);

    const runId = randomUUID();
    this.#insertarRun(runId, input, repository, preferencia);

    const finished = this.#ejecutar(runId, input, repository, preferencia, credential);
    this.#enCurso.set(runId, finished);
    void finished.finally(() => this.#enCurso.delete(runId));
    return { id: runId, finished };
  }

  /** Espera a que terminen los runs en curso, para un apagado ordenado. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#enCurso.values()]);
  }

  async #ejecutar(
    runId: string,
    input: StartRunInput,
    repository: RepositoryRow,
    preferencia: PreferenceRow,
    credential: Awaited<ReturnType<ProviderCredentialService["getUsable"]>>,
  ): Promise<RunRow> {
    try {
      const salida = await this.workspaces.withClonedRepository(
        {
          runId,
          installationId: repository.installationId,
          githubRepositoryId: repository.githubRepoId,
        },
        async (workspace) => {
          this.#marcar(runId, "running", { commit_sha: workspace.baseSha });
          return this.agent.run({
            runId,
            userId: input.userId,
            volumeName: workspace.volumeName,
            owner: repository.owner,
            repository: repository.name,
            branch: repository.defaultBranch,
            baseSha: workspace.baseSha,
            providerId: preferencia.provider_id,
            modelId: preferencia.model_id,
            credential,
          });
        },
      );

      const { report, warnings } = this.#validar(salida.structured);
      this.#persistirResultado(runId, report, warnings, salida);
      return { id: runId, status: "succeeded", errorCode: null };
    } catch (error) {
      const { code, message } = describirFallo(error);
      // Sin esto el error se perdia entero: `#ejecutar` no rejecta nunca, asi
      // que el `catch` de la ruta no dispara y la unica huella quedaba siendo
      // "Fallo inesperado", que no sirve para diagnosticar nada.
      this.logger.error(
        {
          runId,
          code,
          repositoryId: input.repositoryId,
          err: error,
          detalle: error instanceof AppError ? error.details : undefined,
        },
        "la auditoria fallo",
      );
      this.#marcar(runId, code === "RUN_TIMEOUT" ? "timed_out" : "failed", {
        error_code: code,
        error_message: message,
        error_detail: detalleParaElUsuario(error),
        finished_at: this.now(),
      });
      return { id: runId, status: code === "RUN_TIMEOUT" ? "timed_out" : "failed", errorCode: code };
    }
  }

  /**
   * Valida el structured output contra el contrato.
   *
   * `normalizeReport` no rechaza: corrige lo corregible y anota el resto en
   * `warnings`. Perder una auditoria de 20 minutos porque una URL era `http`
   * seria absurdo. Lo que si rechaza es un informe que no valida el schema.
   */
  #validar(structured: unknown): { report: MaintenanceReport; warnings: unknown[] } {
    const parsed = maintenanceReportSchema.safeParse(structured);
    if (!parsed.success) {
      throw new AppError(
        "SCHEMA_INVALID",
        "El informe del agente no cumple el contrato.",
        422,
        parsed.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    const normalized = normalizeReport(parsed.data);
    return { report: normalized.report, warnings: normalized.warnings };
  }

  #persistirResultado(
    runId: string,
    report: MaintenanceReport,
    warnings: unknown[],
    salida: { sessionId: string; containerId: string; tokensInput: number | null; tokensOutput: number | null; costUsd: number | null },
  ): void {
    const ahora = this.now();
    const escribir = this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          `UPDATE runs SET status = 'succeeded', result_json = ?, health_score = ?, headline = ?,
             findings_count = ?, opencode_session_id = ?, container_id = ?,
             tokens_input = ?, tokens_output = ?, cost_usd = ?,
             finished_at = ?, duration_ms = ? - started_at
           WHERE id = ?`,
        )
        .run(
          JSON.stringify({ report, warnings }),
          report.summary.health_score,
          report.summary.headline,
          report.findings.length,
          salida.sessionId,
          salida.containerId,
          salida.tokensInput,
          salida.tokensOutput,
          salida.costUsd,
          ahora,
          ahora,
          runId,
        );

      let seq = 0;
      for (const step of report.steps) {
        this.database.sqlite
          .prepare(
            `INSERT INTO run_steps (id, run_id, seq, key, title, description, status, evidence_json, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            runId,
            seq += 1,
            step.key,
            step.title,
            step.description,
            step.status,
            step.evidence ? JSON.stringify(step.evidence) : null,
            ahora,
          );
      }

      for (const finding of report.findings) {
        this.database.sqlite
          .prepare(
            `INSERT INTO run_findings
               (id, run_id, finding_key, category, severity, effort, confidence, title,
                description, recommendation, locations_json, references_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            runId,
            finding.finding_key,
            finding.category,
            finding.severity,
            finding.effort ?? null,
            finding.confidence ?? null,
            finding.title,
            finding.description,
            finding.recommendation,
            finding.locations ? JSON.stringify(finding.locations) : null,
            finding.references ? JSON.stringify(finding.references) : null,
            ahora,
          );
      }
    });
    escribir();
  }

  #buscarRepositorio(userId: string, repositoryId: string): RepositoryRow {
    const row = this.database.sqlite
      .prepare(
        `SELECT r.id, r.owner, r.name, r.default_branch AS defaultBranch,
                r.github_repo_id AS githubRepoId, gi.installation_id AS installationId
         FROM repositories r
         INNER JOIN github_installations gi ON gi.id = r.installation_id
         WHERE r.id = ? AND r.user_id = ? AND r.unlinked_at IS NULL AND gi.suspended_at IS NULL`,
      )
      .get(repositoryId, userId) as RepositoryRow | undefined;
    if (!row) throw AppError.notFound("Repositorio no encontrado o sin instalacion activa.");
    return row;
  }

  /** El override del repositorio gana sobre la preferencia global. */
  #buscarPreferencia(userId: string, repositoryId: string): PreferenceRow {
    const row = this.database.sqlite
      .prepare(
        `SELECT provider_id, model_id FROM user_model_preferences
         WHERE user_id = ? AND (repository_id = ? OR repository_id IS NULL)
         ORDER BY repository_id IS NULL
         LIMIT 1`,
      )
      .get(userId, repositoryId) as PreferenceRow | undefined;
    if (!row) {
      throw new AppError(
        "PROVIDER_NOT_CONFIGURED",
        "Elegi un modelo por defecto antes de auditar.",
        412,
      );
    }
    return row;
  }

  #insertarRun(
    runId: string,
    input: StartRunInput,
    repository: RepositoryRow,
    preferencia: PreferenceRow,
  ): void {
    const ahora = this.now();
    this.database.sqlite
      .prepare(
        `INSERT INTO runs
           (id, user_id, repository_id, audit_type, status, trigger, provider_id, model_id,
            agent_version, schema_version, base_branch, queued_at, started_at)
         VALUES (?, ?, ?, ?, 'preparing', 'manual', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        input.userId,
        repository.id,
        input.auditType ?? "maintenance",
        preferencia.provider_id,
        preferencia.model_id,
        AGENT_VERSION,
        SCHEMA_VERSION,
        repository.defaultBranch,
        ahora,
        ahora,
      );
  }

  #marcar(runId: string, status: string, campos: Record<string, unknown>): void {
    const columnas = Object.keys(campos);
    const sets = ["status = ?", ...columnas.map((columna) => `${columna} = ?`)].join(", ");
    this.database.sqlite
      .prepare(`UPDATE runs SET ${sets} WHERE id = ?`)
      .run(status, ...columnas.map((columna) => campos[columna] as never), runId);
  }
}

function describirFallo(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  // El mensaje real, no uno generico: es la auditoria del propio usuario y sin
  // esto el fallo es indiagnosticable desde la UI. El stack queda solo en el log.
  const mensaje = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL_ERROR", message: mensaje.slice(0, 500) };
}

/**
 * Detalle estructurado para la UI: los `details` del AppError (por ejemplo, que
 * campo del schema fallo) o los ultimos logs del contenedor del agente.
 */
function detalleParaElUsuario(error: unknown): string | null {
  if (error instanceof AppError && error.details !== undefined) {
    return JSON.stringify(error.details).slice(0, 8_000);
  }
  return null;
}
