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
import { healthRoutes } from "./routes/health.ts";
import { createAuth, type AppAuth } from "./services/auth.ts";
import { CredentialCrypto } from "./services/credential-crypto.ts";

export function buildServer(config: Config): FastifyInstance {
  const database = openDatabase(config.DATABASE_PATH);
  const credentialCrypto = new CredentialCrypto(masterKeyBytes(config));
  const auth = createAuth(config, database.db);
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
  app.decorate("auth", auth);
  app.addHook("onClose", () => database.close());

  registerErrorHandler(app);

  app.register(healthRoutes, { prefix: "/api" });
  authRoutes(app);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: AppDatabase;
    database: DatabaseConnection;
    credentialCrypto: CredentialCrypto;
    auth: AppAuth;
  }
}
