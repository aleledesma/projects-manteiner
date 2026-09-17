import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { AppError } from "../errors.ts";

const oauthProviderSchema = z.object({ providerId: z.literal("openai") });
const oauthStatusSchema = z.object({ pollToken: z.uuid() });
const credentialParamsSchema = z.object({ id: z.uuid() });
const apiCredentialSchema = z.object({
  providerId: z.string().trim().min(1).max(100),
  apiKey: z.string().min(1).max(10_000),
  label: z.string().trim().min(1).max(100).optional(),
});
const catalogRefreshSchema = z.object({
  providerId: z.string().trim().min(1).max(100).optional(),
});
const modelPreferenceSchema = z.object({
  providerId: z.string().trim().min(1).max(100),
  modelId: z.string().trim().min(1).max(200),
  smallModelId: z.string().trim().min(1).max(200).nullable().optional(),
});
const repositoryParamsSchema = z.object({ id: z.uuid() });

export function providerRoutes(app: FastifyInstance): void {
  app.get("/api/providers", async (request) => {
    const userId = await requireUserId(app, request);
    return app.providerCredentials.list(userId);
  });

  app.get("/api/providers/catalog", async (request) => {
    await requireUserId(app, request);
    return app.providerCatalog.get();
  });

  app.post("/api/providers/catalog/refresh", async (request) => {
    const userId = await requireUserId(app, request);
    const { providerId } = catalogRefreshSchema.parse(request.body ?? {});
    const credential = providerId
      ? { providerId, payload: app.providerCredentials.getActive(userId, providerId) }
      : undefined;
    return app.providerCatalog.refresh(credential);
  });

  app.post("/api/providers", async (request, reply) => {
    const userId = await requireUserId(app, request);
    const input = apiCredentialSchema.parse(request.body);
    await app.providerCatalog.validateApiKey(input.providerId, input.apiKey);
    const credential = app.providerCredentials.save(
      userId,
      input.providerId,
      { type: "api", key: input.apiKey },
      { label: input.label },
    );
    return reply.status(201).send(credential);
  });

  app.post("/api/providers/oauth/:providerId/start", async (request) => {
    const userId = await requireUserId(app, request);
    oauthProviderSchema.parse(request.params);
    return app.openAIOAuth.start(userId);
  });

  app.get("/api/providers/oauth/:providerId/status", async (request) => {
    const userId = await requireUserId(app, request);
    oauthProviderSchema.parse(request.params);
    const { pollToken } = oauthStatusSchema.parse(request.query);
    return app.openAIOAuth.status(userId, pollToken);
  });

  app.delete("/api/providers/:id", async (request, reply) => {
    const userId = await requireUserId(app, request);
    const { id } = credentialParamsSchema.parse(request.params);
    app.providerCredentials.delete(userId, id);
    return reply.status(204).send();
  });

  app.get("/api/preferences/model", async (request) => {
    const userId = await requireUserId(app, request);
    return app.modelPreferences.getGlobal(userId);
  });

  app.put("/api/preferences/model", async (request) => {
    const userId = await requireUserId(app, request);
    return app.modelPreferences.setGlobal(userId, modelPreferenceSchema.parse(request.body));
  });

  app.patch("/api/repos/:id", async (request) => {
    const userId = await requireUserId(app, request);
    const { id } = repositoryParamsSchema.parse(request.params);
    return app.modelPreferences.setForRepository(userId, id, modelPreferenceSchema.parse(request.body));
  });
}

async function requireUserId(app: FastifyInstance, request: FastifyRequest): Promise<string> {
  const session = await app.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) throw AppError.unauthorized();
  return session.user.id;
}
