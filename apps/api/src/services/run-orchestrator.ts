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
  constructor(
    private readonly database: DatabaseConnection,
    private readonly workspaces: RepositoryWorkspaceService,
    private readonly agent: AgentRuntime,
    private readonly credentials: ProviderCredentialService,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Crea el run y lo ejecuta hasta el final. Devuelve la fila ya terminada:
   * el streaming es la Fase 6, asi que por ahora el cliente espera.
   */
  async start(input: StartRunInput): Promise<RunRow> {
    const repository = this.#buscarRepositorio(input.userId, input.repositoryId);
    const preferencia = this.#buscarPreferencia(input.userId, input.repositoryId);
    // Se resuelve antes de crear el run: fallar en `queued` da un mensaje util,
    // fallar a mitad del clon obliga a interpretar un run muerto.
    const credential = await this.credentials.getUsable(input.userId, preferencia.provider_id);

    const runId = randomUUID();
    this.#insertarRun(runId, input, repository, preferencia);

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
      this.#marcar(runId, code === "RUN_TIMEOUT" ? "timed_out" : "failed", {
        error_code: code,
        error_message: message,
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
  return { code: "INTERNAL_ERROR", message: "Fallo inesperado durante la auditoria." };
}
