/**
 * Rate limiting (Fase 9, doc 10).
 *
 * Por usuario y no por IP: detras de un NAT o del mismo proxy, limitar por IP
 * castigaria a todos por igual. Solo el login va por IP, porque ahi todavia no
 * hay usuario. Los limites estrictos van en lo que gasta dinero (tokens del
 * proveedor) o levanta contenedores.
 */

import rateLimit, { type RateLimitOptions } from "@fastify/rate-limit";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { AppError } from "./errors.ts";

export const LIMITES = {
  /** Cada auditoria consume tokens del proveedor y un contenedor por media hora. */
  runs: { max: 5, timeWindow: "1 hour" },
  /** Validar una API key o iniciar un device flow llama al proveedor real. */
  providerAuth: { max: 10, timeWindow: "10 minutes", groupId: "provider-auth" },
  /** Refrescar el catalogo levanta un contenedor de opencode. */
  catalogRefresh: { max: 3, timeWindow: "10 minutes" },
  /** Login y callbacks de OAuth: sin sesion todavia, se limita por IP. */
  auth: { max: 20, timeWindow: "1 minute", keyGenerator: (request: FastifyRequest) => `ip:${request.ip}` },
} satisfies Record<string, RateLimitOptions>;

/** Limite general para el resto de `/api/*`. */
const GENERAL = { max: 300, timeWindow: "1 minute" } as const;

export function registerRateLimit(app: FastifyInstance): void {
  if (!app.config.RATE_LIMIT_ENABLED) return;

  app.register(rateLimit, {
    global: true,
    ...GENERAL,
    keyGenerator: async (request) => {
      try {
        const session = await app.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (session) return `user:${session.user.id}`;
      } catch {
        // Sin sesion valida se cae al limite por IP.
      }
      return `ip:${request.ip}`;
    },
    errorResponseBuilder: (_request, context) => {
      const segundos = Math.max(1, Math.ceil(context.ttl / 1000));
      return new AppError(
        "RATE_LIMITED",
        `Demasiadas solicitudes. Proba de nuevo en ${esperaLegible(segundos)}.`,
        429,
        { retryAfterSeconds: segundos },
      );
    },
  });
}

function esperaLegible(segundos: number): string {
  if (segundos < 60) return `${segundos} s`;
  const minutos = Math.ceil(segundos / 60);
  return minutos === 1 ? "1 minuto" : `${minutos} minutos`;
}
