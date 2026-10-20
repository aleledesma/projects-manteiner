/**
 * Orquestador del run: clonar, auditar, validar y persistir.
 *
 * El volumen y los contenedores se destruyen siempre, por el `finally` de
 * `withClonedRepository`, haya terminado bien, mal, por timeout o por
 * cancelacion. Esa garantia es la razon de ser de todo el diseno (doc 05).
 *
 * Si el agente propuso un PR, se publica antes de soltar el volumen: el
 * contenedor de publicacion necesita el working tree que dejo el agente.
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
import { redactSecrets } from "../redact.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import type { ProviderCredentialService } from "./provider-credentials.ts";
import { filesInDiff, type PullRequestOutcome, type PullRequestService } from "./pull-requests.ts";
import type { ClonedWorkspace, RepositoryWorkspaceService } from "./repository-workspace.ts";
import type { RunEventBus } from "./run-events.ts";

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

export interface RunLimits {
  /** Runs con contenedor vivo a la vez. El resto espera en `queued`. */
  readonly maxConcurrentRuns: number;
  /** Runs en espera como maximo; por encima se rechaza con 429. */
  readonly maxQueuedRuns: number;
}

const LIMITES_POR_DEFECTO: RunLimits = { maxConcurrentRuns: 2, maxQueuedRuns: 10 };

type Credential = Awaited<ReturnType<ProviderCredentialService["getUsable"]>>;

export class RunOrchestratorService {
  /** Runs vivos en este proceso, para poder esperarlos al apagar. */
  readonly #enCurso = new Map<string, Promise<RunRow>>();
  /** `started_at` de cada run vivo, para calcular la duracion al fallar. */
  readonly #inicio = new Map<string, number>();
  /** Runs esperando un lugar, en orden de llegada. Cada uno es su `resolve`. */
  readonly #cola: Array<() => void> = [];
  #activos = 0;
  #cerrando = false;

  constructor(
    private readonly database: DatabaseConnection,
    private readonly workspaces: RepositoryWorkspaceService,
    private readonly agent: AgentRuntime,
    private readonly credentials: ProviderCredentialService,
    private readonly eventos: RunEventBus,
    private readonly now: () => number = Date.now,
    private readonly logger: RunLogger = { error: () => {} },
    /** Sin servicio de PRs (tests, o GitHub sin permisos) la auditoria corre igual. */
    private readonly pullRequests?: PullRequestService,
    private readonly limites: RunLimits = LIMITES_POR_DEFECTO,
  ) {}

  /**
   * Crea el run y lo lanza. Devuelve el id apenas la fila existe, sin esperar a
   * que termine: una auditoria puede durar media hora y dejar un fetch colgado
   * todo ese tiempo es fragil. El cliente sigue el estado por `GET /api/runs/:id`
   * hasta que la Fase 6 traiga el streaming.
   *
   * `finished` queda expuesto para los tests y para el apagado ordenado.
   */
  async start(
    input: StartRunInput,
  ): Promise<{ id: string; status: "preparing" | "queued"; finished: Promise<RunRow> }> {
    if (this.#cerrando) {
      throw new AppError("SERVER_SHUTTING_DOWN", "La API se esta apagando; intenta en unos segundos.", 503);
    }
    const repository = this.#buscarRepositorio(input.userId, input.repositoryId);
    const preferencia = this.#buscarPreferencia(input.userId, input.repositoryId);
    // Se resuelve antes de crear el run: fallar antes de insertar da un mensaje
    // util, fallar a mitad del clon obliga a interpretar un run muerto.
    const credential = await this.credentials.getUsable(input.userId, preferencia.provider_id);
    this.#exigirSinRunActivo(repository.id);

    const encolado = this.#activos >= this.limites.maxConcurrentRuns;
    if (encolado && this.#cola.length >= this.limites.maxQueuedRuns) {
      throw new AppError(
        "RUN_QUEUE_FULL",
        "Hay demasiadas auditorias en espera. Proba de nuevo cuando termine alguna.",
        429,
      );
    }

    const runId = randomUUID();
    const status = encolado ? "queued" : "preparing";
    this.#insertarRun(runId, input, repository, preferencia, status);
    this.eventos.publish(runId, { type: "run.status", payload: { status, at: this.now() } });

    // `#ejecutar` no deberia rechazar, pero si su propio catch falla (por
    // ejemplo un SQLITE_BUSY al marcar el run) la promesa rechaza. Sin este
    // handler seria un unhandledRejection, que en Node tumba el proceso.
    const finished = this.#esperarTurno()
      .then(() => this.#ejecutar(runId, input, repository, preferencia, encolado ? null : credential))
      .catch((error: unknown) => {
        this.logger.error({ runId, err: error }, "el run no pudo registrar su propio fallo");
        return { id: runId, status: "failed", errorCode: "INTERNAL_ERROR" } satisfies RunRow;
      })
      .finally(() => {
        this.#liberarTurno();
        this.#enCurso.delete(runId);
      });

    this.#enCurso.set(runId, finished);
    return { id: runId, status, finished };
  }

  /**
   * Apagado ordenado: no se aceptan runs nuevos, los encolados se cancelan sin
   * levantar contenedores y se espera a los que ya estan corriendo.
   */
  async close(): Promise<void> {
    this.#cerrando = true;
    this.#cola.splice(0).forEach((despertar) => {
      this.#activos += 1;
      despertar();
    });
    await Promise.allSettled([...this.#enCurso.values()]);
  }

  /** Toma un lugar libre o espera en la cola, en orden de llegada. */
  #esperarTurno(): Promise<void> {
    if (this.#activos < this.limites.maxConcurrentRuns) {
      this.#activos += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#cola.push(resolve));
  }

  /** El lugar pasa directo al siguiente de la cola, sin pasar por cero. */
  #liberarTurno(): void {
    const siguiente = this.#cola.shift();
    if (siguiente) siguiente();
    else this.#activos -= 1;
  }

  /** Un solo run activo por repositorio: evita PRs duplicados (doc 01). */
  #exigirSinRunActivo(repositoryId: string): void {
    const activo = this.database.sqlite
      .prepare(
        `SELECT id FROM runs
         WHERE repository_id = ?
           AND status IN ('queued','preparing','cloning','running','collecting','publishing_pr','generating_report')
         LIMIT 1`,
      )
      .get(repositoryId);
    if (activo) {
      throw AppError.conflict("RUN_ALREADY_ACTIVE", "Este repositorio ya tiene una auditoria en curso.");
    }
  }

  async #ejecutar(
    runId: string,
    input: StartRunInput,
    repository: RepositoryRow,
    preferencia: PreferenceRow,
    credencialInicial: Credential | null,
  ): Promise<RunRow> {
    try {
      let credential = credencialInicial;
      if (credential === null) {
        // Estuvo en cola: puede haber esperado lo suficiente como para que un
        // token OAuth necesite refresco, asi que se vuelve a pedir.
        if (this.#cerrando) {
          throw new AppError("SERVER_SHUTTING_DOWN", "La API se apago antes de que el run arrancara.", 503);
        }
        this.#marcar(runId, "preparing", { started_at: this.now() });
        this.eventos.publish(runId, { type: "run.status", payload: { status: "preparing", at: this.now() } });
        credential = await this.credentials.getUsable(input.userId, preferencia.provider_id);
      }
      this.#inicio.set(runId, this.now());
      const credencial = credential;

      const { salida, report, warnings, pullRequest } = await this.workspaces.withClonedRepository(
        {
          runId,
          installationId: repository.installationId,
          githubRepositoryId: repository.githubRepoId,
        },
        async (workspace) => {
          this.#marcar(runId, "running", { commit_sha: workspace.baseSha });
          this.eventos.publish(runId, { type: "run.status", payload: { status: "running", at: this.now() } });
          const salida = await this.agent.run({
            runId,
            userId: input.userId,
            volumeName: workspace.volumeName,
            owner: repository.owner,
            repository: repository.name,
            branch: repository.defaultBranch,
            baseSha: workspace.baseSha,
            providerId: preferencia.provider_id,
            modelId: preferencia.model_id,
            credential: credencial,
            onEvent: (evento) => this.eventos.publish(runId, evento),
          });
          // Se valida antes de publicar: un informe que no cumple el contrato
          // no puede abrir un PR en el repositorio de nadie.
          const { report, warnings } = this.#validar(salida.structured);
          const pullRequest = await this.#publicar(runId, input, repository, workspace, report, salida.diff);
          return { salida, report, warnings, pullRequest };
        },
      );

      this.#persistirResultado(runId, report, warnings, salida, pullRequest);
      this.#inicio.delete(runId);
      this.eventos.publish(runId, {
        type: "run.completed",
        payload: {
          healthScore: report.summary.health_score,
          findingsCount: report.findings.length,
          headline: report.summary.headline,
        },
      });
      this.eventos.forget(runId);
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
        // Se persiste y se muestra en la UI: un token en un log de contenedor
        // no puede terminar guardado en la base.
        error_message: redactSecrets(message),
        error_detail: detalleParaElUsuario(error),
        finished_at: this.now(),
        // El camino de exito lo calcula en SQL; el de fallo tambien lo necesita
        // o la UI muestra "sin duracion" en todos los runs que fallaron.
        duration_ms: this.now() - (this.#inicio.get(runId) ?? this.now()),
      });
      this.#inicio.delete(runId);
      this.eventos.publish(runId, { type: "run.failed", payload: { code, message: redactSecrets(message) } });
      this.eventos.forget(runId);
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
      const issues = parsed.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join(".") || "(raiz)",
        message: issue.message,
      }));
      const primera = issues[0];
      throw new AppError(
        "SCHEMA_INVALID",
        // El mensaje lleva la primera incoherencia: "no cumple el contrato" a
        // secas obliga a abrir el detalle para saber si hay algo que hacer.
        primera
          ? `El informe no cumple el contrato — ${primera.path}: ${primera.message}`
          : "El informe del agente no cumple el contrato.",
        422,
        {
          issues,
          // El informe crudo, para poder ver que devolvio realmente el modelo.
          // Es lo unico que queda de una auditoria de varios minutos.
          recibido: recorte(structured),
        },
      );
    }
    const normalized = normalizeReport(parsed.data);
    return { report: normalized.report, warnings: normalized.warnings };
  }

  /**
   * Publica el PR si el agente propuso uno. Un fallo de publicacion NO invalida
   * la auditoria (doc 03): queda registrado y el informe se guarda igual. La
   * unica excepcion es `INVALID_PUSH_TARGET`, que indica un bug y tumba el run.
   */
  async #publicar(
    runId: string,
    input: StartRunInput,
    repository: RepositoryRow,
    workspace: ClonedWorkspace,
    report: MaintenanceReport,
    diff: string,
  ): Promise<PullRequestOutcome | null> {
    const propuesta = report.proposed_pull_request;
    if (!this.pullRequests || !propuesta) return null;

    this.#marcar(runId, "publishing_pr", {});
    this.eventos.publish(runId, { type: "run.status", payload: { status: "publishing_pr", at: this.now() } });

    const resultado = await this.pullRequests.publish({
      runId,
      auditType: input.auditType ?? "maintenance",
      installationId: repository.installationId,
      githubRepositoryId: repository.githubRepoId,
      volumeName: workspace.volumeName,
      baseSha: workspace.baseSha,
      title: propuesta.title,
      body: propuesta.body,
      touchedFiles: filesInDiff(diff),
    });

    if (resultado.status === "created") {
      this.eventos.publish(runId, {
        type: "run.pr_created",
        payload: { number: resultado.number, url: resultado.url, branch: resultado.branch },
      });
    } else if (resultado.status === "failed") {
      this.logger.error({ runId, pullRequest: resultado }, "el PR no se publico");
    }
    return resultado;
  }

  #persistirResultado(
    runId: string,
    report: MaintenanceReport,
    warnings: unknown[],
    salida: {
      sessionId: string;
      containerId: string;
      diff: string;
      tokensInput: number | null;
      tokensOutput: number | null;
      costUsd: number | null;
    },
    pullRequest: PullRequestOutcome | null,
  ): void {
    const ahora = this.now();
    const escribir = this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          `UPDATE runs SET status = 'succeeded', result_json = ?, health_score = ?, headline = ?,
             findings_count = ?, opencode_session_id = ?, container_id = ?,
             tokens_input = ?, tokens_output = ?, cost_usd = ?,
             pr_number = ?, pr_url = ?, pr_branch = ?,
             finished_at = ?, duration_ms = ? - started_at
           WHERE id = ?`,
        )
        .run(
          // El diff viaja con el informe: es lo que despues alimenta el visor
          // de diff y el PR de la Fase 7, y capturarlo sin guardarlo no servia.
          JSON.stringify({ report, warnings, diff: salida.diff || null, pullRequest }),
          report.summary.health_score,
          report.summary.headline,
          report.findings.length,
          salida.sessionId,
          salida.containerId,
          salida.tokensInput,
          salida.tokensOutput,
          salida.costUsd,
          pullRequest?.status === "created" ? pullRequest.number : null,
          pullRequest?.status === "created" ? pullRequest.url : null,
          pullRequest?.status === "created"
            ? pullRequest.branch
            : pullRequest?.status === "failed" ? pullRequest.branch : null,
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
    status: "preparing" | "queued",
  ): void {
    const ahora = this.now();
    this.database.sqlite
      .prepare(
        `INSERT INTO runs
           (id, user_id, repository_id, audit_type, status, trigger, provider_id, model_id,
            agent_version, schema_version, base_branch, queued_at, started_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        input.userId,
        repository.id,
        input.auditType ?? "maintenance",
        status,
        preferencia.provider_id,
        preferencia.model_id,
        AGENT_VERSION,
        SCHEMA_VERSION,
        repository.defaultBranch,
        ahora,
        // Un run encolado todavia no empezo: su duracion se mide desde que toma lugar.
        status === "queued" ? null : ahora,
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

/** Recorta el informe crudo para que quepa en `error_detail` sin llenar la base. */
function recorte(valor: unknown): string {
  try {
    return JSON.stringify(valor).slice(0, 20_000);
  } catch {
    return String(valor).slice(0, 2_000);
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
    return redactSecrets(JSON.stringify(error.details)).slice(0, 32_000);
  }
  return null;
}
