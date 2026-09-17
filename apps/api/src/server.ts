/**
 * Construccion de la app Fastify.
 *
 * `buildServer` no escucha en ningun puerto: devuelve la instancia lista. Eso
 * permite que los tests la levanten con `app.inject()` sin abrir sockets.
 * El `listen` vive en index.ts.
 */

import Fastify, { type FastifyInstance } from "fastify";

import { masterKeyBytes, type Config } from "./config.ts";
import { openDatabase, type AppDatabase, type DatabaseConnection } from "./db/client.ts";
import { registerErrorHandler } from "./errors.ts";
import { authRoutes } from "./routes/auth.ts";
import { githubRoutes } from "./routes/github.ts";
import { healthRoutes } from "./routes/health.ts";
import { providerRoutes } from "./routes/providers.ts";
import { runRoutes } from "./routes/runs.ts";
import { DockerAgentRuntime, type AgentDockerClient, type AgentRuntime } from "./services/agent-runtime.ts";
import { createAuth, type AppAuth } from "./services/auth.ts";
import { CredentialCrypto } from "./services/credential-crypto.ts";
import { DockerService, type DockerClient } from "./services/docker.ts";
import { GithubAppService } from "./services/github-app.ts";
import { OpenAIOAuthService } from "./services/openai-oauth.ts";
import { ModelPreferenceService } from "./services/model-preferences.ts";
import { DockerOpencodeRuntime } from "./services/opencode-runtime.ts";
import { ProviderCatalogService, type OpencodeProviderRuntime } from "./services/provider-catalog.ts";
import { ProviderCredentialService } from "./services/provider-credentials.ts";
import { OrphanCleanupService, type CleanupDockerClient } from "./services/docker-cleanup.ts";
import { RunOrchestratorService } from "./services/run-orchestrator.ts";
import {
  DockerWorkspaceRuntime,
  RepositoryWorkspaceService,
  type WorkspaceDockerClient,
} from "./services/repository-workspace.ts";

export interface ServerDependencies {
  dockerClient?: DockerClient;
  workspaceDockerClient?: WorkspaceDockerClient;
  fetch?: typeof fetch;
  now?: () => number;
  providerRuntime?: OpencodeProviderRuntime;
  agentRuntime?: AgentRuntime;
  agentDockerClient?: AgentDockerClient;
  cleanupDockerClient?: CleanupDockerClient;
}

export function buildServer(config: Config, dependencies: ServerDependencies = {}): FastifyInstance {
  const database = openDatabase(config.DATABASE_PATH);
  const credentialCrypto = new CredentialCrypto(masterKeyBytes(config));
  let providerCredentials!: ProviderCredentialService;
  const openAIOAuth = new OpenAIOAuthService({
    fetch: dependencies.fetch,
    now: dependencies.now,
    httpTimeoutMs: config.PROVIDER_HTTP_TIMEOUT_MS,
    flowTimeoutMs: config.OAUTH_DEVICE_TIMEOUT_MS,
    onAuthorized: async (userId, credential) => {
      providerCredentials.save(userId, "openai", credential, { label: "ChatGPT Plus/Pro" });
    },
  });
  providerCredentials = new ProviderCredentialService(
    database,
    credentialCrypto,
    (credential) => openAIOAuth.refresh(credential),
    config.RUN_TIMEOUT_MS + config.REFRESH_MARGIN_MS,
    dependencies.now,
  );
  const providerRuntime = dependencies.providerRuntime ?? new DockerOpencodeRuntime(config);
  const providerCatalog = new ProviderCatalogService({
    runtime: providerRuntime,
    cachePath: config.PROVIDER_CATALOG_PATH,
    maxAgeMs: config.PROVIDER_CATALOG_MAX_AGE_MS,
    now: dependencies.now,
    defaultCredential: () => {
      const active = providerCredentials.firstActive();
      return active ? { providerId: active.providerId, payload: active.payload } : undefined;
    },
  });
  const modelPreferences = new ModelPreferenceService(
    database,
    providerCredentials,
    providerCatalog,
    dependencies.now,
  );
  const auth = createAuth(config, database.db);
  const githubApp = new GithubAppService(config);
  const docker = new DockerService(config, dependencies.dockerClient);
  const repositoryWorkspace = new RepositoryWorkspaceService(
    config,
    githubApp,
    new DockerWorkspaceRuntime(config, dependencies.workspaceDockerClient),
  );
  const agentRuntime = dependencies.agentRuntime
    ?? new DockerAgentRuntime(config, dependencies.agentDockerClient, dependencies.fetch);
  const runs = new RunOrchestratorService(
    database,
    repositoryWorkspace,
    agentRuntime,
    providerCredentials,
    dependencies.now,
  );
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // En desarrollo, salida legible. En produccion, JSON para que lo coma un colector.
      ...(config.isProduction
        ? {}
        : { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }),
      // Primera capa de redaccion de secretos (doc 10). La redaccion por patron
      // (sk-*, ghp_*, JWT) llega en la Fase 9; esto cubre lo obvio desde el dia uno.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers['set-cookie']",
          "*.api_key",
          "*.apiKey",
          "*.access",
          "*.refresh",
          "*.token",
          "*.MASTER_KEY",
          "*.SESSION_SECRET",
        ],
        censor: "[REDACTADO]",
      },
    },
    // No confiar en X-Forwarded-* salvo detras de un proxy propio.
    trustProxy: false,
    // Nota: no usamos `disableRequestLogging` (deprecado en Fastify 5.12) ni
    // `logController` (exige implementar la interfaz entera). Para callar la
    // salida en tests alcanza con LOG_LEVEL=silent, que es lo que hacen.
  });

  app.decorate("config", config);
  app.decorate("db", database.db);
  app.decorate("database", database);
  app.decorate("credentialCrypto", credentialCrypto);
  app.decorate("providerCredentials", providerCredentials);
  app.decorate("openAIOAuth", openAIOAuth);
  app.decorate("providerCatalog", providerCatalog);
  app.decorate("modelPreferences", modelPreferences);
  app.decorate("auth", auth);
  app.decorate("githubApp", githubApp);
  app.decorate("docker", docker);
  app.decorate("repositoryWorkspace", repositoryWorkspace);
  app.decorate("runs", runs);
  app.addHook("onClose", async () => {
    openAIOAuth.close();
    // Los runs vivos terminan antes de cerrar la base: si no, el `finally` que
    // destruye el volumen escribiria sobre una conexion cerrada.
    await runs.close();
    await providerCatalog.close();
    database.close();
  });
  if (!config.isTest) {
    app.addHook("onReady", async () => {
      // Antes que nada: un volumen huerfano tiene el repositorio de alguien
      // adentro, y el disenio se apoya en que eso no sobreviva al run (doc 05).
      const cleanup = new OrphanCleanupService(
        database,
        config,
        dependencies.cleanupDockerClient,
        dependencies.now,
      );
      const reporte = await cleanup.run();
      if (reporte.runs + reporte.containers + reporte.volumes > 0 || reporte.failures.length > 0) {
        app.log.info(reporte, "limpieza de huerfanos al arrancar");
      }
      if (reporte.failures.length > 0) {
        app.log.warn({ failures: reporte.failures }, "quedaron huerfanos sin limpiar");
      }

      providerCatalog.start((error) => app.log.warn({ err: error }, "no se pudo refrescar el catalogo"));
    });
  }

  registerErrorHandler(app);

  app.register(healthRoutes, { prefix: "/api" });
  authRoutes(app);
  githubRoutes(app);
  providerRoutes(app);
  runRoutes(app);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: AppDatabase;
    database: DatabaseConnection;
    credentialCrypto: CredentialCrypto;
    providerCredentials: ProviderCredentialService;
    openAIOAuth: OpenAIOAuthService;
    providerCatalog: ProviderCatalogService;
    modelPreferences: ModelPreferenceService;
    auth: AppAuth;
    githubApp: GithubAppService;
    docker: DockerService;
    repositoryWorkspace: RepositoryWorkspaceService;
    runs: RunOrchestratorService;
  }
}
