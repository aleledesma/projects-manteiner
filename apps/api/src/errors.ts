/**
 * Errores de dominio y forma uniforme de respuesta.
 *
 * Contrato del doc 09:
 *   { "error": { "code": "PROVIDER_AUTH_FAILED", "message": "..." } }
 *
 * `code` es estable y apto para que el frontend ramifique.
 * `message` es para humanos y puede cambiar sin previo aviso.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  override readonly name = "AppError";

  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details?: unknown,
  ) {
    super(message);
  }

  static notFound(message = "No encontrado") {
    return new AppError("NOT_FOUND", message, 404);
  }

  static unauthorized(message = "No autenticado") {
    return new AppError("UNAUTHENTICATED", message, 401);
  }

  static conflict(code: string, message: string) {
    return new AppError(code, message, 409);
  }
}

/**
 * Handler unico de errores.
 *
 * Nada de filtrar internals: un error no previsto sale como INTERNAL_ERROR con
 * un mensaje generico, y el detalle real solo va al log. Un stack trace en la
 * respuesta HTTP es una filtracion de informacion, no una ayuda al usuario.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      const context = { err, code: err.code, statusCode: err.statusCode };
      if (err.statusCode >= 500) req.log.error(context, "error de dominio");
      else req.log.info(context, "error de dominio");
      return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
    }

    if (err instanceof ZodError) {
      const details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      req.log.info({ details }, "error de validacion");
      return reply
        .status(400)
        .send(body("VALIDATION_ERROR", "Los datos enviados no son validos.", details));
    }

    // Errores del propio Fastify (schemas de ruta, body malformado, 413...).
    // `err` llega tipado como unknown, asi que se estrecha antes de tocarlo:
    // cualquier cosa puede haber sido lanzada, no solo un Error.
    const fastifyErr = err as Partial<FastifyError>;
    const statusCode = fastifyErr.statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      req.log.info({ err }, "error de request");
      return reply
        .status(statusCode)
        .send(body(fastifyErr.code ?? "BAD_REQUEST", fastifyErr.message ?? "Request invalida"));
    }

    req.log.error({ err }, "error no manejado");
    return reply
      .status(500)
      .send(body("INTERNAL_ERROR", "Ocurrio un error inesperado. Se registro el detalle."));
  });

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    return reply
      .status(404)
      .send(body("NOT_FOUND", `No existe la ruta ${req.method} ${req.url}`));
  });
}

function body(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
