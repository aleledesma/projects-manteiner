import type { FastifyInstance } from "fastify";

import { SCHEMA_VERSION } from "@manteiner/contracts";

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    const docker = await app.docker.status();
    return {
      status: "ok" as const,
      uptimeMs: Date.now() - startedAt,
      env: app.config.NODE_ENV,
      docker: { available: docker.available },
      // Version del contrato del agente: util para saber que espera esta instancia
      // sin tener que mirar el codigo.
      contractSchemaVersion: SCHEMA_VERSION,
    };
  });
}
