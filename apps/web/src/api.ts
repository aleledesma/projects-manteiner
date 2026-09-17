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

export type Severity = "high" | "medium" | "low" | "info";

export type RunStatus =
  | "preparing" | "cloning" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";

export type LastRun = {
  id: string;
  status: RunStatus;
  healthScore: number | null;
  headline: string | null;
  findingsCount: number;
  modelId: string;
  errorCode: string | null;
  queuedAt: number;
  finishedAt: number | null;
  severities: Record<Severity, number>;
};

export type LinkedRepository = {
  id: string;
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  primaryLanguage: string | null;
  htmlUrl: string;
  linkedAt: number;
  lastRun: LastRun | null;
};

/** El informe validado, tal como lo define @manteiner/contracts. */
export type Report = {
  schema_version: string;
  summary: { health_score: number; headline: string; overview: string };
  stack_detected: { name: string; version?: string | null; category: string; source?: string | null }[];
  steps: {
    key: string; title: string; status: "completed" | "skipped" | "failed";
    description: string; evidence?: string[] | null; skip_reason?: string | null;
  }[];
  dependency_updates: {
    applied: { name: string; from: string; to: string; bump: string; scope?: string | null; changelog_url?: string | null; rationale?: string | null }[];
    deferred: { name: string; from: string; to: string; reason?: string | null; migration_url?: string | null }[];
    unmaintained: { name: string; reason?: string | null }[];
  };
  findings: {
    finding_key: string; category: string; severity: Severity;
    effort?: string | null; confidence: string; title: string;
    description: string; recommendation: string;
    locations?: { path: string; line?: number | null }[] | null;
    references?: { url: string; title?: string | null; kind?: string | null }[] | null;
  }[];
  proposed_pull_request: { title: string; body: string } | null;
  out_of_scope_notes: { area: string; note: string }[];
  limitations: string[];
};

export type Run = {
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  auditType: string;
  status: RunStatus;
  providerId: string;
  modelId: string;
  agentVersion: string;
  commitSha: string | null;
  baseBranch: string | null;
  healthScore: number | null;
  findingsCount: number;
  headline: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** JSON con los detalles del fallo: campos del schema o logs del contenedor. */
  errorDetail: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costUsd: number | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  result: { report: Report; warnings: unknown[] } | null;
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
