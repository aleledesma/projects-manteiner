import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "../errors.ts";
import type { OAuthProviderCredential } from "./credential-crypto.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const DEVICE_URL = `${ISSUER}/codex/device`;
const REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const DEFAULT_INTERVAL_SECONDS = 5;
const POLL_SAFETY_MARGIN_MS = 1_000;

const deviceCodeSchema = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1),
  interval: z.coerce.number().positive().optional(),
});

const deviceTokenSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
});

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  id_token: z.string().optional(),
});

export type OAuthFlowStatus = "pending" | "authorized" | "expired" | "failed";

interface PendingFlow {
  readonly userId: string;
  readonly pollToken: string;
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly expiresAt: number;
  status: OAuthFlowStatus;
  errorCode?: string;
}

export interface OAuthStartResult {
  readonly url: string;
  readonly userCode: string;
  readonly expiresIn: number;
  readonly pollToken: string;
}

export interface OAuthStatusResult {
  readonly status: OAuthFlowStatus;
  readonly expiresAt: number;
  readonly errorCode?: string;
}

export interface OpenAIOAuthOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly httpTimeoutMs: number;
  readonly flowTimeoutMs: number;
  readonly onAuthorized: (userId: string, credential: OAuthProviderCredential) => Promise<void>;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class OpenAIOAuthService {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #httpTimeoutMs: number;
  readonly #flowTimeoutMs: number;
  readonly #onAuthorized: OpenAIOAuthOptions["onAuthorized"];
  readonly #sleep: NonNullable<OpenAIOAuthOptions["sleep"]>;
  readonly #flows = new Map<string, PendingFlow>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #requestControllers = new Set<AbortController>();

  constructor(options: OpenAIOAuthOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#httpTimeoutMs = options.httpTimeoutMs;
    this.#flowTimeoutMs = options.flowTimeoutMs;
    this.#onAuthorized = options.onAuthorized;
    this.#sleep = options.sleep ?? delay;
  }

  async start(userId: string): Promise<OAuthStartResult> {
    this.#deleteUserFlows(userId);
    const response = await this.#postJson(`${ISSUER}/api/accounts/deviceauth/usercode`, {
      client_id: CLIENT_ID,
    });
    if (!response.ok) throw providerError("No se pudo iniciar la autorizacion con OpenAI.");

    const parsed = deviceCodeSchema.safeParse(response.body);
    if (!parsed.success) throw providerError("OpenAI devolvio una respuesta de autorizacion invalida.");

    const pollToken = randomUUID();
    const expiresAt = this.#now() + this.#flowTimeoutMs;
    const flow: PendingFlow = {
      userId,
      pollToken,
      deviceAuthId: parsed.data.device_auth_id,
      userCode: parsed.data.user_code,
      expiresAt,
      status: "pending",
    };
    this.#flows.set(pollToken, flow);

    const intervalMs = (parsed.data.interval ?? DEFAULT_INTERVAL_SECONDS) * 1_000 + POLL_SAFETY_MARGIN_MS;
    void this.#poll(flow, intervalMs);

    return {
      url: DEVICE_URL,
      userCode: flow.userCode,
      expiresIn: Math.ceil(this.#flowTimeoutMs / 1_000),
      pollToken,
    };
  }

  status(userId: string, pollToken: string): OAuthStatusResult {
    const flow = this.#flows.get(pollToken);
    if (!flow || flow.userId !== userId) throw AppError.notFound("Flujo OAuth no encontrado.");
    if (flow.status === "pending" && flow.expiresAt <= this.#now()) flow.status = "expired";
    return {
      status: flow.status,
      expiresAt: flow.expiresAt,
      ...(flow.errorCode ? { errorCode: flow.errorCode } : {}),
    };
  }

  close(): void {
    for (const controller of this.#controllers.values()) controller.abort();
    for (const controller of this.#requestControllers) controller.abort();
    this.#controllers.clear();
    this.#requestControllers.clear();
    this.#flows.clear();
  }

  async refresh(current: OAuthProviderCredential): Promise<OAuthProviderCredential> {
    const response = await this.#postForm(`${ISSUER}/oauth/token`, {
      grant_type: "refresh_token",
      refresh_token: current.refresh,
      client_id: CLIENT_ID,
    });
    if (!response.ok) throw new AppError(
      "PROVIDER_REFRESH_FAILED",
      "La conexion con OpenAI vencio. Volve a conectar tu cuenta.",
      401,
    );
    const parsed = tokenSchema.safeParse(response.body);
    if (!parsed.success) throw providerError("OpenAI devolvio tokens de refresco invalidos.");
    return {
      ...current,
      access: parsed.data.access_token,
      refresh: parsed.data.refresh_token ?? current.refresh,
      expires: this.#now() + (parsed.data.expires_in ?? 3_600) * 1_000,
    };
  }

  async #poll(flow: PendingFlow, intervalMs: number): Promise<void> {
    try {
      while (flow.status === "pending" && this.#now() < flow.expiresAt) {
        const controller = new AbortController();
        this.#controllers.set(flow.pollToken, controller);
        await this.#sleep(intervalMs, controller.signal);
        this.#controllers.delete(flow.pollToken);
        if (flow.status !== "pending" || this.#now() >= flow.expiresAt) break;

        const response = await this.#postJson(`${ISSUER}/api/accounts/deviceauth/token`, {
          device_auth_id: flow.deviceAuthId,
          user_code: flow.userCode,
        });
        if (response.status === 403 || response.status === 404) continue;
        if (!response.ok) throw providerError("OpenAI rechazo el flujo de autorizacion.");
        const authorization = deviceTokenSchema.safeParse(response.body);
        if (!authorization.success) throw providerError("OpenAI devolvio una autorizacion invalida.");

        const credential = await this.#exchange(authorization.data);
        await this.#onAuthorized(flow.userId, credential);
        flow.status = "authorized";
        return;
      }
      if (flow.status === "pending") flow.status = "expired";
    } catch (error) {
      if (flow.status !== "pending") return;
      flow.status = "failed";
      flow.errorCode = error instanceof AppError ? error.code : "PROVIDER_AUTH_FAILED";
    } finally {
      this.#controllers.delete(flow.pollToken);
    }
  }

  async #exchange(authorization: z.infer<typeof deviceTokenSchema>): Promise<OAuthProviderCredential> {
    const response = await this.#postForm(`${ISSUER}/oauth/token`, {
      grant_type: "authorization_code",
      code: authorization.authorization_code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: authorization.code_verifier,
    });
    if (!response.ok) throw providerError("No se pudo completar la autorizacion con OpenAI.");
    const parsed = tokenSchema.safeParse(response.body);
    if (!parsed.success || !parsed.data.refresh_token) {
      throw providerError("OpenAI devolvio tokens de autorizacion invalidos.");
    }
    const accountId = extractAccountId(parsed.data.id_token, parsed.data.access_token);
    if (!accountId) throw providerError("OpenAI no informo la cuenta autorizada.");
    return {
      type: "oauth",
      access: parsed.data.access_token,
      refresh: parsed.data.refresh_token,
      expires: this.#now() + (parsed.data.expires_in ?? 3_600) * 1_000,
      accountId,
    };
  }

  async #postJson(url: string, body: unknown): Promise<HttpResult> {
    return this.#request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "manteiner/0.1.0" },
      body: JSON.stringify(body),
    });
  }

  async #postForm(url: string, body: Record<string, string>): Promise<HttpResult> {
    return this.#request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "manteiner/0.1.0" },
      body: new URLSearchParams(body).toString(),
    });
  }

  async #request(url: string, init: RequestInit): Promise<HttpResult> {
    const controller = new AbortController();
    this.#requestControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.#httpTimeoutMs);
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal });
      const raw = await response.text();
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      return { ok: response.ok, status: response.status, body };
    } catch (cause) {
      throw appErrorWithCause("PROVIDER_UNAVAILABLE", "OpenAI no respondio a tiempo.", 502, cause);
    } finally {
      clearTimeout(timer);
      this.#requestControllers.delete(controller);
    }
  }

  #deleteUserFlows(userId: string): void {
    for (const [pollToken, flow] of this.#flows) {
      if (flow.userId !== userId) continue;
      this.#controllers.get(pollToken)?.abort();
      this.#controllers.delete(pollToken);
      this.#flows.delete(pollToken);
    }
  }
}

interface HttpResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

function decodeJwt(token: string | undefined): Record<string, unknown> | undefined {
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function extractAccountId(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    const claims = decodeJwt(token);
    if (!claims) continue;
    const auth = claims["https://api.openai.com/auth"];
    if (auth && typeof auth === "object") {
      const accountId = (auth as Record<string, unknown>)["chatgpt_account_id"];
      if (typeof accountId === "string" && accountId) return accountId;
    }
    for (const key of ["chatgpt_account_id", "account_id"]) {
      const accountId = claims[key];
      if (typeof accountId === "string" && accountId) return accountId;
    }
  }
  return undefined;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function providerError(message: string): AppError {
  return new AppError("PROVIDER_AUTH_FAILED", message, 502);
}

function appErrorWithCause(code: string, message: string, statusCode: number, cause: unknown): AppError {
  const error = new AppError(code, message, statusCode);
  Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  return error;
}
