/**
 * Cliente HTTP de la API. Traduce el contrato de errores del doc 09
 * (`{ error: { code, message } }`) a una excepción con `code` estable, para que
 * las vistas puedan ramificar por código y no por texto.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    });
  } catch {
    throw new ApiError("NETWORK_ERROR", "No se pudo contactar al servidor.", 0);
  }

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      error?.code ?? "INTERNAL_ERROR",
      error?.message ?? "Ocurrió un error inesperado.",
      response.status,
    );
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: (path: string) => request<void>(path, { method: "DELETE" }),
};

/* ── Formas del contrato (doc 09) ───────────────────────────────────────── */

export type Onboarding = {
  hasProvider: boolean;
  hasInstallation: boolean;
  hasRepos: boolean;
};

export type Me = {
  user: {
    id: string;
    githubLogin: string | null;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  };
  onboarding: Onboarding;
};

export type CatalogModel = {
  id: string;
  name: string;
  status?: string;
  capabilities: { toolcall: true } & Record<string, unknown>;
  limit?: { context?: number; output?: number };
  cost?: { input: number; output: number };
};

export type CatalogProvider = {
  id: string;
  name: string;
  models: CatalogModel[];
};

export type Catalog = {
  refreshedAt: number;
  providers: CatalogProvider[];
};

export type ProviderCredential = {
  id: string;
  providerId: string;
  authType: "api" | "oauth";
  label: string | null;
  lastFour: string | null;
  status: "active" | "invalid" | "revoked";
  verifiedAt: number | null;
  expiresAt: number | null;
};

export type ModelPreference = {
  id: string;
  repositoryId: string | null;
  providerId: string;
  modelId: string;
  smallModelId: string | null;
};

export type OAuthStart = {
  url: string;
  userCode: string;
  expiresIn: number;
  pollToken: string;
};

export type OAuthStatus = {
  status: "pending" | "authorized" | "expired" | "failed";
  expiresAt: number;
  errorCode?: string;
};

export type GithubInstallation = {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  /** `all` o `selected`: qué eligió el usuario al instalar la App. */
  repositorySelection: string;
  suspendedAt: number | null;
  suspended: boolean;
  accessibleRepos: number;
  linkedRepos: number;
};

export type AvailableRepository = {
  githubRepoId: number;
  installationId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  primaryLanguage: string | null;
  htmlUrl: string;
};
