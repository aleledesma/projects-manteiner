import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { AppError } from "../errors.ts";
import { LIMITES } from "../rate-limit.ts";

export function authRoutes(app: FastifyInstance): void {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: { rateLimit: LIMITES.auth },
    handler: async (request, reply) => {
      const response = await app.auth.handler(toWebRequest(request, app.config.PUBLIC_URL));

      reply.status(response.status);
      for (const [name, value] of response.headers) {
        if (name !== "set-cookie") reply.header(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);

      const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
      return reply.send(body);
    },
  });

  app.get("/api/me", async (request) => {
    const session = await app.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!session) throw AppError.unauthorized();

    const onboarding = app.database.sqlite
      .prepare(
        `SELECT
          EXISTS(SELECT 1 FROM provider_credentials WHERE user_id = ? AND status = 'active') AS hasProvider,
          EXISTS(SELECT 1 FROM github_user_installations WHERE user_id = ?) AS hasInstallation,
          EXISTS(SELECT 1 FROM repositories WHERE user_id = ? AND unlinked_at IS NULL) AS hasRepos`,
      )
      .get(session.user.id, session.user.id, session.user.id) as {
      hasProvider: number;
      hasInstallation: number;
      hasRepos: number;
    };

    return {
      user: {
        id: session.user.id,
        githubLogin: session.user.githubLogin,
        name: session.user.name,
        email: session.user.email,
        avatarUrl: session.user.image,
      },
      onboarding: {
        hasProvider: onboarding.hasProvider === 1,
        hasInstallation: onboarding.hasInstallation === 1,
        hasRepos: onboarding.hasRepos === 1,
      },
    };
  });
}

function toWebRequest(request: FastifyRequest, baseURL: string): Request {
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" || request.body === undefined
    ? undefined
    : typeof request.body === "string"
      ? request.body
      : JSON.stringify(request.body);

  return new Request(new URL(request.url, baseURL), {
    method,
    headers: fromNodeHeaders(request.headers),
    body,
  });
}
