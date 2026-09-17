import { createPrivateKey, createSign } from "node:crypto";

import { z } from "zod";

import { githubAppPrivateKeyBytes, type Config } from "../config.ts";
import { AppError } from "../errors.ts";

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({
    id: z.number().int().positive(),
    login: z.string(),
    type: z.enum(["User", "Organization"]),
  }),
  repository_selection: z.enum(["all", "selected"]),
  suspended_at: z.string().nullable(),
});

const accessTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
});

const repositorySchema = z.object({
  id: z.number().int().positive(),
  owner: z.object({ login: z.string() }),
  name: z.string(),
  full_name: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
  language: z.string().nullable(),
  html_url: z.url(),
});

const repositoryListSchema = z.object({
  repositories: z.array(repositorySchema),
});

const oauthTokenSchema = z.object({
  access_token: z.string().min(1),
});

const githubUserSchema = z.object({ id: z.number().int().positive() });
const organizationMembershipSchema = z.object({
  state: z.enum(["active", "pending"]),
  role: z.enum(["admin", "member"]),
});

export type GithubInstallation = z.infer<typeof installationSchema>;
export type GithubRepository = z.infer<typeof repositorySchema>;

export class GithubAppService {
  private readonly privateKey;
  private readonly listingTokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    private readonly config: Config,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.privateKey = createPrivateKey(githubAppPrivateKeyBytes(config));
  }

  installationUrl(state: string): string {
    const url = new URL(`https://github.com/apps/${this.config.GITHUB_APP_SLUG}/installations/new`);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeUserCode(code: string): Promise<string> {
    const response = await this.request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.GITHUB_APP_CLIENT_ID,
        client_secret: this.config.GITHUB_APP_CLIENT_SECRET,
        code,
      }),
    });
    return oauthTokenSchema.parse(await response.json()).access_token;
  }

  async userCanAccessInstallation(token: string, installationId: number): Promise<boolean> {
    const response = await this.fetch(
      `${API_BASE}/user/installations/${installationId}/repositories?per_page=1`,
      { headers: this.githubHeaders(token) },
    );
    if (response.status === 403 || response.status === 404) return false;
    if (!response.ok) throw this.apiError(response.status);
    return true;
  }

  async getAuthenticatedUserId(token: string): Promise<number> {
    const response = await this.request(`${API_BASE}/user`, {
      headers: this.githubHeaders(token),
    });
    return githubUserSchema.parse(await response.json()).id;
  }

  async userIsOrganizationAdmin(token: string, organization: string): Promise<boolean> {
    const response = await this.fetch(
      `${API_BASE}/user/memberships/orgs/${encodeURIComponent(organization)}`,
      { headers: this.githubHeaders(token) },
    );
    if (response.status === 403 || response.status === 404) return false;
    if (!response.ok) throw this.apiError(response.status);
    const membership = organizationMembershipSchema.parse(await response.json());
    return membership.state === "active" && membership.role === "admin";
  }

  async revokeUserToken(token: string): Promise<void> {
    const credentials = Buffer.from(
      `${this.config.GITHUB_APP_CLIENT_ID}:${this.config.GITHUB_APP_CLIENT_SECRET}`,
    ).toString("base64");
    const response = await this.fetch(
      `${API_BASE}/applications/${this.config.GITHUB_APP_CLIENT_ID}/token`,
      {
        method: "DELETE",
        headers: {
          ...this.githubHeaders(),
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ access_token: token }),
      },
    );
    if (!response.ok && response.status !== 404) throw this.apiError(response.status);
  }

  async getInstallation(installationId: number): Promise<GithubInstallation> {
    const response = await this.request(`${API_BASE}/app/installations/${installationId}`, {
      headers: this.githubHeaders(this.createAppJwt()),
    });
    return installationSchema.parse(await response.json());
  }

  async listInstallationRepositories(installationId: number): Promise<GithubRepository[]> {
    const token = await this.getListingToken(installationId);
    const repositories: GithubRepository[] = [];

    for (let page = 1; ; page += 1) {
      const response = await this.request(
        `${API_BASE}/installation/repositories?per_page=100&page=${page}`,
        { headers: this.githubHeaders(token) },
      );
      const batch = repositoryListSchema.parse(await response.json()).repositories;
      repositories.push(...batch);
      if (batch.length < 100) return repositories;
    }
  }

  async createCloneToken(installationId: number, repositoryId: number): Promise<string> {
    const response = await this.request(
      `${API_BASE}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: { ...this.githubHeaders(this.createAppJwt()), "Content-Type": "application/json" },
        body: JSON.stringify({
          repository_ids: [repositoryId],
          permissions: { contents: "read" },
        }),
      },
    );
    return accessTokenSchema.parse(await response.json()).token;
  }

  createAppJwt(now = Math.floor(Date.now() / 1000)): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: this.config.GITHUB_APP_ID }),
    ).toString("base64url");
    const unsigned = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(unsigned).end().sign(this.privateKey);
    return `${unsigned}.${signature.toString("base64url")}`;
  }

  private async getListingToken(installationId: number): Promise<string> {
    const cached = this.listingTokens.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;

    const response = await this.request(
      `${API_BASE}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: { ...this.githubHeaders(this.createAppJwt()), "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: { metadata: "read" } }),
      },
    );
    const data = accessTokenSchema.parse(await response.json());
    this.listingTokens.set(installationId, {
      token: data.token,
      expiresAt: Date.parse(data.expires_at),
    });
    return data.token;
  }

  private githubHeaders(token?: string): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "manteiner",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private fetch(input: string, init?: RequestInit): Promise<Response> {
    return (this.fetchImpl ?? globalThis.fetch)(input, init);
  }

  private async request(input: string, init?: RequestInit): Promise<Response> {
    const response = await this.fetch(input, init);
    if (!response.ok) throw this.apiError(response.status);
    return response;
  }

  private apiError(status: number): AppError {
    return new AppError(
      "GITHUB_API_ERROR",
      "GitHub rechazo la operacion. Intenta nuevamente.",
      status === 429 ? 503 : 502,
    );
  }
}
