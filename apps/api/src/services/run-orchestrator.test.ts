import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { validReport } from "@manteiner/contracts/fixtures";

import { openDatabase, type DatabaseConnection } from "../db/client.ts";
import { AppError } from "../errors.ts";
import type { AgentRunInput, AgentRunOutput, AgentRuntime } from "./agent-runtime.ts";
import { CredentialCrypto } from "./credential-crypto.ts";
import { ProviderCredentialService } from "./provider-credentials.ts";
import type { RepositoryWorkspaceService } from "./repository-workspace.ts";
import { RunEventBus } from "./run-events.ts";
import type { PullRequestOutcome, PullRequestService } from "./pull-requests.ts";
import { RunOrchestratorService } from "./run-orchestrator.ts";

const informe = validReport();
const REPO_ID = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];
const abiertas: DatabaseConnection[] = [];
// En Windows el archivo queda bloqueado mientras la conexion siga abierta, asi
// que hay que cerrar antes de borrar el directorio.
afterEach(() => {
  abiertas.splice(0).forEach((database) => database.close());
  directories.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function preparar(): { database: DatabaseConnection; credentials: ProviderCredentialService } {
  const directory = mkdtempSync(join(tmpdir(), "manteiner-runs-"));
  directories.push(directory);
  const database = openDatabase(join(directory, "test.db"));
  abiertas.push(database);

  database.sqlite.prepare(
    `INSERT INTO users (id, github_id, github_login, email_verified, created_at, updated_at)
     VALUES ('user-1', 1, 'one', 0, 1, 1)`,
  ).run();
  database.sqlite.prepare(
    `INSERT INTO github_installations
      (id, installation_id, account_login, account_type, repository_selection, created_at, updated_at)
     VALUES ('inst-1', 4242, 'one', 'User', 'selected', 1, 1)`,
  ).run();
  database.sqlite.prepare(
    `INSERT INTO repositories
      (id, user_id, installation_id, github_repo_id, owner, name, full_name, default_branch,
       private, html_url, linked_at)
     VALUES (?, 'user-1', 'inst-1', 77, 'one', 'repo', 'one/repo', 'main', 0,
             'https://github.com/one/repo', 1)`,
  ).run(REPO_ID);

  const credentials = new ProviderCredentialService(
    database,
    new CredentialCrypto(randomBytes(32)),
    async () => assert.fail("no debe refrescar"),
    100,
  );
  credentials.save("user-1", "openai", { type: "api", key: "secret" });
  return { database, credentials };
}

function conPreferencia(database: DatabaseConnection, repositoryId: string | null): void {
  database.sqlite.prepare(
    `INSERT INTO user_model_preferences
      (id, user_id, repository_id, provider_id, model_id, created_at, updated_at)
     VALUES (?, 'user-1', ?, 'openai', ?, 1, 1)`,
  ).run(`pref-${repositoryId ?? "global"}`, repositoryId, repositoryId ? "modelo-repo" : "modelo-global");
}

/** Workspace falso: registra si el volumen se destruyo en todos los caminos. */
function workspaceFalso(registro: { destruido: boolean }): RepositoryWorkspaceService {
  return {
    async withClonedRepository(
      _input: unknown,
      useWorkspace: (workspace: { volumeName: string; baseSha: string; sizeKb: number }) => Promise<unknown>,
    ) {
      try {
        return await useWorkspace({ volumeName: "manteiner-ws-test", baseSha: "a".repeat(40), sizeKb: 10 });
      } finally {
        registro.destruido = true;
      }
    },
  } as unknown as RepositoryWorkspaceService;
}

function agenteFalso(
  respuesta: Partial<AgentRunOutput> | (() => never),
  capturado?: { input?: AgentRunInput },
): AgentRuntime {
  return {
    async run(input: AgentRunInput) {
      if (capturado) capturado.input = input;
      if (typeof respuesta === "function") respuesta();
      return {
        structured: informe,
        sessionId: "ses-1",
        containerId: "cont-1",
        diff: "",
        tokensInput: 100,
        tokensOutput: 20,
        costUsd: null,
        steps: [],
        ...respuesta,
      } as AgentRunOutput;
    },
  };
}

describe("RunOrchestratorService", () => {
  it("persiste el informe, los pasos y los hallazgos", async () => {
    const { database, credentials } = preparar();
    conPreferencia(database, null);
    const registro = { destruido: false };
    const service = new RunOrchestratorService(
      database,
      workspaceFalso(registro),
      agenteFalso({}),
      credentials,
      new RunEventBus(database, () => 5_000),
      () => 5_000,
    );

    const run = await (await service.start({ userId: "user-1", repositoryId: REPO_ID })).finished;
    assert.equal(run.status, "succeeded");
    assert.equal(registro.destruido, true);

    const fila = database.sqlite
      .prepare("SELECT status, health_score, findings_count, opencode_session_id, model_id FROM runs WHERE id = ?")
      .get(run.id) as Record<string, unknown>;
    assert.equal(fila["status"], "succeeded");
    assert.equal(fila["model_id"], "modelo-global");
    assert.equal(fila["opencode_session_id"], "ses-1");
    assert.equal(fila["health_score"], informe.summary.health_score);
    assert.equal(fila["findings_count"], informe.findings.length);

    const pasos = database.sqlite
      .prepare("SELECT count(*) AS n FROM run_steps WHERE run_id = ?").get(run.id) as { n: number };
    const hallazgos = database.sqlite
      .prepare("SELECT count(*) AS n FROM run_findings WHERE run_id = ?").get(run.id) as { n: number };
    assert.equal(pasos.n, informe.steps.length);
    assert.equal(hallazgos.n, informe.findings.length);
  });

  it("el override del repositorio le gana a la preferencia global", async () => {
    const { database, credentials } = preparar();
    conPreferencia(database, null);
    conPreferencia(database, REPO_ID);
    const capturado: { input?: AgentRunInput } = {};
    const service = new RunOrchestratorService(
      database,
      workspaceFalso({ destruido: false }),
      agenteFalso({}, capturado),
      credentials,
      new RunEventBus(database),
    );

    await (await service.start({ userId: "user-1", repositoryId: REPO_ID })).finished;
    assert.equal(capturado.input?.modelId, "modelo-repo");
  });

  it("marca SCHEMA_INVALID sin perder el run cuando el informe no cumple el contrato", async () => {
    const { database, credentials } = preparar();
    conPreferencia(database, null);
    const registro = { destruido: false };
    const service = new RunOrchestratorService(
      database,
      workspaceFalso(registro),
      agenteFalso({ structured: { nada: "que ver" } }),
      credentials,
      new RunEventBus(database),
    );

    const run = await (await service.start({ userId: "user-1", repositoryId: REPO_ID })).finished;
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "SCHEMA_INVALID");
    // El volumen se destruye igual: es la garantia del diseno.
    assert.equal(registro.destruido, true);
    const fila = database.sqlite
      .prepare("SELECT status, error_code, result_json FROM runs WHERE id = ?")
      .get(run.id) as Record<string, unknown>;
    assert.equal(fila["status"], "failed");
    assert.equal(fila["error_code"], "SCHEMA_INVALID");
    assert.equal(fila["result_json"], null);
  });

  it("registra timed_out cuando el agente excede el tiempo", async () => {
    const { database, credentials } = preparar();
    conPreferencia(database, null);
    const service = new RunOrchestratorService(
      database,
      workspaceFalso({ destruido: false }),
      agenteFalso(() => {
        throw new AppError("RUN_TIMEOUT", "excedido", 504);
      }),
      credentials,
      new RunEventBus(database),
    );

    const run = await (await service.start({ userId: "user-1", repositoryId: REPO_ID })).finished;
    assert.equal(run.status, "timed_out");
    const fila = database.sqlite
      .prepare("SELECT status, error_code FROM runs WHERE id = ?").get(run.id) as Record<string, unknown>;
    assert.equal(fila["status"], "timed_out");
    assert.equal(fila["error_code"], "RUN_TIMEOUT");
  });

  it("no crea el run si falta elegir modelo", async () => {
    const { database, credentials } = preparar();
    const service = new RunOrchestratorService(
      database,
      workspaceFalso({ destruido: false }),
      agenteFalso({}),
      credentials,
      new RunEventBus(database),
    );

    await assert.rejects(
      service.start({ userId: "user-1", repositoryId: REPO_ID }),
      (error) => error instanceof AppError && error.code === "PROVIDER_NOT_CONFIGURED",
    );
    const filas = database.sqlite.prepare("SELECT count(*) AS n FROM runs").get() as { n: number };
    assert.equal(filas.n, 0);
  });

  it("no deja auditar un repositorio de otro usuario", async () => {
    const { database, credentials } = preparar();
    conPreferencia(database, null);
    const service = new RunOrchestratorService(
      database,
      workspaceFalso({ destruido: false }),
      agenteFalso({}),
      credentials,
      new RunEventBus(database),
    );

    await assert.rejects(
      service.start({ userId: "user-2", repositoryId: REPO_ID }),
      (error) => error instanceof AppError && error.statusCode === 404,
    );
  });

  it("publica el PR propuesto antes de soltar el volumen y guarda numero y url", async () => {
    const { database, credentials } = preparar();
    conPreferencia(database, null);
    const registro = { destruido: false };
    let volumenVivoAlPublicar = false;
    const prs = {
      async publish(input: { volumeName: string; title: string }) {
        volumenVivoAlPublicar = !registro.destruido && input.volumeName === "manteiner-ws-test";
        return {
          status: "created",
          number: 7,
          url: "https://github.com/one/repo/pull/7",
          branch: "manteiner/maintenance/abcdef12",
          commitSha: "c".repeat(40),
          files: ["package.json"],
          discarded: [],
        } satisfies PullRequestOutcome;
      },
    } as unknown as PullRequestService;
    const bus = new RunEventBus(database);
    const service = new RunOrchestratorService(
      database,
      workspaceFalso(registro),
      agenteFalso({ diff: "diff --git a/package.json b/package.json\n" }),
      credentials,
      bus,
      Date.now,
      undefined,
      prs,
    );

    const run = await (await service.start({ userId: "user-1", repositoryId: REPO_ID })).finished;
    assert.equal(run.status, "succeeded");
    assert.equal(volumenVivoAlPublicar, true);
    const fila = database.sqlite
      .prepare("SELECT pr_number, pr_url, pr_branch, result_json FROM runs WHERE id = ?")
      .get(run.id) as Record<string, unknown>;
    assert.equal(fila["pr_number"], 7);
    assert.equal(fila["pr_url"], "https://github.com/one/repo/pull/7");
    assert.equal(fila["pr_branch"], "manteiner/maintenance/abcdef12");
    assert.equal(JSON.parse(fila["result_json"] as string).pullRequest.status, "created");
  });

  it("un PR fallido no invalida la auditoria", async () => {
    const { database, credentials } = preparar();
    conPreferencia(database, null);
    const prs = {
      async publish() {
        return { status: "failed", code: "GITHUB_PERMISSION_MISSING", message: "sin permiso", branch: null };
      },
    } as unknown as PullRequestService;
    const service = new RunOrchestratorService(
      database,
      workspaceFalso({ destruido: false }),
      agenteFalso({}),
      credentials,
      new RunEventBus(database),
      Date.now,
      undefined,
      prs,
    );

    const run = await (await service.start({ userId: "user-1", repositoryId: REPO_ID })).finished;
    assert.equal(run.status, "succeeded");
    const fila = database.sqlite
      .prepare("SELECT pr_number, result_json FROM runs WHERE id = ?")
      .get(run.id) as Record<string, unknown>;
    assert.equal(fila["pr_number"], null);
    assert.equal(JSON.parse(fila["result_json"] as string).pullRequest.code, "GITHUB_PERMISSION_MISSING");
  });

  it("INVALID_PUSH_TARGET tumba el run", async () => {
    const { database, credentials } = preparar();
    conPreferencia(database, null);
    const prs = {
      async publish() {
        throw new AppError("INVALID_PUSH_TARGET", "rama prohibida", 500);
      },
    } as unknown as PullRequestService;
    const registro = { destruido: false };
    const service = new RunOrchestratorService(
      database,
      workspaceFalso(registro),
      agenteFalso({}),
      credentials,
      new RunEventBus(database),
      Date.now,
      undefined,
      prs,
    );

    const run = await (await service.start({ userId: "user-1", repositoryId: REPO_ID })).finished;
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "INVALID_PUSH_TARGET");
    assert.equal(registro.destruido, true);
  });

  describe("cola de runs", () => {
    const REPO_2 = "22222222-2222-4222-8222-222222222222";

    function segundoRepo(database: DatabaseConnection): void {
      database.sqlite.prepare(
        `INSERT INTO repositories
          (id, user_id, installation_id, github_repo_id, owner, name, full_name, default_branch,
           private, html_url, linked_at)
         VALUES (?, 'user-1', 'inst-1', 78, 'one', 'repo2', 'one/repo2', 'main', 0,
                 'https://github.com/one/repo2', 1)`,
      ).run(REPO_2);
    }

    /** Agente que no termina hasta que el test lo suelta. */
    function agenteBloqueado(): { agente: AgentRuntime; soltar: () => void; corridas: string[] } {
      let soltar!: () => void;
      const barrera = new Promise<void>((resolve) => (soltar = resolve));
      const corridas: string[] = [];
      const agente: AgentRuntime = {
        async run(input: AgentRunInput) {
          corridas.push(input.repository);
          await barrera;
          return {
            structured: informe, sessionId: "s", containerId: "c", diff: "",
            tokensInput: null, tokensOutput: null, costUsd: null, steps: [],
          } as unknown as AgentRunOutput;
        },
      };
      return { agente, soltar, corridas };
    }

    it("encola por encima del limite y arranca el siguiente al liberarse el lugar", async () => {
      const { database, credentials } = preparar();
      conPreferencia(database, null);
      segundoRepo(database);
      const { agente, soltar, corridas } = agenteBloqueado();
      const service = new RunOrchestratorService(
        database, workspaceFalso({ destruido: false }), agente, credentials,
        new RunEventBus(database), Date.now, undefined, undefined,
        { maxConcurrentRuns: 1, maxQueuedRuns: 5 },
      );

      const primero = await service.start({ userId: "user-1", repositoryId: REPO_ID });
      const segundo = await service.start({ userId: "user-1", repositoryId: REPO_2 });
      assert.equal(primero.status, "preparing");
      assert.equal(segundo.status, "queued");
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(corridas, ["repo"]);
      const encolado = database.sqlite
        .prepare("SELECT status, started_at FROM runs WHERE id = ?").get(segundo.id) as Record<string, unknown>;
      assert.equal(encolado["status"], "queued");
      assert.equal(encolado["started_at"], null);

      soltar();
      assert.equal((await primero.finished).status, "succeeded");
      assert.equal((await segundo.finished).status, "succeeded");
      assert.deepEqual(corridas, ["repo", "repo2"]);
    });

    it("rechaza con 429 si la cola esta llena y con 409 un segundo run del mismo repo", async () => {
      const { database, credentials } = preparar();
      conPreferencia(database, null);
      segundoRepo(database);
      const { agente, soltar } = agenteBloqueado();
      const service = new RunOrchestratorService(
        database, workspaceFalso({ destruido: false }), agente, credentials,
        new RunEventBus(database), Date.now, undefined, undefined,
        { maxConcurrentRuns: 1, maxQueuedRuns: 0 },
      );

      const primero = await service.start({ userId: "user-1", repositoryId: REPO_ID });
      await assert.rejects(
        service.start({ userId: "user-1", repositoryId: REPO_ID }),
        (error) => error instanceof AppError && error.code === "RUN_ALREADY_ACTIVE",
      );
      await assert.rejects(
        service.start({ userId: "user-1", repositoryId: REPO_2 }),
        (error) => error instanceof AppError && error.code === "RUN_QUEUE_FULL" && error.statusCode === 429,
      );
      soltar();
      await primero.finished;
    });

    it("al apagar, los encolados se cancelan sin levantar contenedores", async () => {
      const { database, credentials } = preparar();
      conPreferencia(database, null);
      segundoRepo(database);
      const { agente, soltar, corridas } = agenteBloqueado();
      const service = new RunOrchestratorService(
        database, workspaceFalso({ destruido: false }), agente, credentials,
        new RunEventBus(database), Date.now, undefined, undefined,
        { maxConcurrentRuns: 1, maxQueuedRuns: 5 },
      );

      await service.start({ userId: "user-1", repositoryId: REPO_ID });
      const segundo = await service.start({ userId: "user-1", repositoryId: REPO_2 });
      const cierre = service.close();
      soltar();
      await cierre;
      assert.equal((await segundo.finished).errorCode, "SERVER_SHUTTING_DOWN");
      assert.deepEqual(corridas, ["repo"]);
    });
  });
});
