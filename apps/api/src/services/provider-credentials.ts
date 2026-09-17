import { randomUUID } from "node:crypto";

import type { DatabaseConnection } from "../db/client.ts";
import { AppError } from "../errors.ts";
import {
  CredentialCrypto,
  type OAuthProviderCredential,
  type ProviderCredentialPayload,
} from "./credential-crypto.ts";

interface CredentialRow {
  id: string;
  user_id: string;
  provider_id: string;
  auth_type: "api" | "oauth";
  label: string | null;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  last_four: string | null;
  status: "active" | "invalid" | "revoked";
  verified_at: number | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SafeProviderCredential {
  readonly id: string;
  readonly providerId: string;
  readonly authType: "api" | "oauth";
  readonly label: string | null;
  readonly lastFour: string | null;
  readonly status: "active" | "invalid" | "revoked";
  readonly verifiedAt: number | null;
  readonly expiresAt: number | null;
}

export class ProviderCredentialService {
  readonly #refreshes = new Map<string, Promise<ProviderCredentialPayload>>();

  constructor(
    private readonly database: DatabaseConnection,
    private readonly crypto: CredentialCrypto,
    private readonly refreshOAuth: (credential: OAuthProviderCredential) => Promise<OAuthProviderCredential>,
    private readonly requiredOAuthLifetimeMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  list(userId: string): SafeProviderCredential[] {
    const rows = this.database.sqlite
      .prepare("SELECT * FROM provider_credentials WHERE user_id = ? ORDER BY provider_id")
      .all(userId) as CredentialRow[];
    return rows.map(safeCredential);
  }

  save(
    userId: string,
    providerId: string,
    payload: ProviderCredentialPayload,
    options: { label?: string | null; verifiedAt?: number } = {},
  ): SafeProviderCredential {
    const encrypted = this.crypto.encrypt({ userId, providerId }, payload);
    const now = this.now();
    const existing = this.database.sqlite
      .prepare("SELECT id, created_at FROM provider_credentials WHERE user_id = ? AND provider_id = ?")
      .get(userId, providerId) as { id: string; created_at: number } | undefined;
    const id = existing?.id ?? randomUUID();
    const createdAt = existing?.created_at ?? now;
    this.database.sqlite.prepare(
      `INSERT INTO provider_credentials
        (id, user_id, provider_id, auth_type, label, ciphertext, iv, auth_tag, key_version,
         last_four, status, verified_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
       ON CONFLICT(user_id, provider_id) DO UPDATE SET
         auth_type = excluded.auth_type, label = excluded.label, ciphertext = excluded.ciphertext,
         iv = excluded.iv, auth_tag = excluded.auth_tag, key_version = excluded.key_version,
         last_four = excluded.last_four, status = 'active', verified_at = excluded.verified_at,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).run(
      id,
      userId,
      providerId,
      payload.type,
      options.label ?? null,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      encrypted.keyVersion,
      payload.type === "api" ? payload.key.slice(-4) : null,
      options.verifiedAt ?? now,
      payload.type === "oauth" ? payload.expires : null,
      createdAt,
      now,
    );
    return safeCredential(this.#rowById(userId, id));
  }

  delete(userId: string, id: string): void {
    const result = this.database.sqlite
      .prepare("DELETE FROM provider_credentials WHERE id = ? AND user_id = ?")
      .run(id, userId);
    if (result.changes === 0) throw AppError.notFound("Credencial no encontrada.");
  }

  getActive(userId: string, providerId: string): ProviderCredentialPayload {
    const row = this.database.sqlite
      .prepare("SELECT * FROM provider_credentials WHERE user_id = ? AND provider_id = ? AND status = 'active'")
      .get(userId, providerId) as CredentialRow | undefined;
    if (!row) throw new AppError(
      "PROVIDER_NOT_CONFIGURED",
      "El proveedor no tiene una credencial activa.",
      412,
    );
    return this.#decrypt(row);
  }

  firstActive(): { userId: string; providerId: string; payload: ProviderCredentialPayload } | undefined {
    const row = this.database.sqlite
      .prepare("SELECT * FROM provider_credentials WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1")
      .get() as CredentialRow | undefined;
    if (!row) return undefined;
    return { userId: row.user_id, providerId: row.provider_id, payload: this.#decrypt(row) };
  }

  async getUsable(
    userId: string,
    providerId: string,
  ): Promise<ProviderCredentialPayload> {
    const row = this.database.sqlite
      .prepare("SELECT * FROM provider_credentials WHERE user_id = ? AND provider_id = ? AND status = 'active'")
      .get(userId, providerId) as CredentialRow | undefined;
    if (!row) throw new AppError(
      "PROVIDER_NOT_CONFIGURED",
      "El proveedor no tiene una credencial activa.",
      412,
    );
    const payload = this.#decrypt(row);
    if (payload.type !== "oauth" || payload.expires >= this.now() + this.requiredOAuthLifetimeMs) {
      return payload;
    }

    const activeRefresh = this.#refreshes.get(row.id);
    if (activeRefresh) return activeRefresh;

    const refresh = this.#refreshAndPersist(row, payload, userId, providerId);
    this.#refreshes.set(row.id, refresh);
    try {
      return await refresh;
    } finally {
      if (this.#refreshes.get(row.id) === refresh) this.#refreshes.delete(row.id);
    }
  }

  async #refreshAndPersist(
    row: CredentialRow,
    payload: OAuthProviderCredential,
    userId: string,
    providerId: string,
  ): Promise<OAuthProviderCredential> {
    let refreshed: OAuthProviderCredential;
    try {
      refreshed = await this.refreshOAuth(payload);
    } catch (cause) {
      this.#markInvalid(row.id, userId);
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        "PROVIDER_REFRESH_FAILED",
        "La conexion con el proveedor vencio. Volve a conectar tu cuenta.",
        401,
      );
    }

    try {
      this.save(userId, providerId, refreshed, { label: row.label, verifiedAt: this.now() });
    } catch (cause) {
      this.#markInvalid(row.id, userId);
      throw appErrorWithCause(
        "PROVIDER_CREDENTIAL_PERSIST_FAILED",
        "No se pudo guardar la credencial renovada. Volve a conectar tu cuenta.",
        500,
        cause,
      );
    }
    return refreshed;
  }

  #rowById(userId: string, id: string): CredentialRow {
    const row = this.database.sqlite
      .prepare("SELECT * FROM provider_credentials WHERE id = ? AND user_id = ?")
      .get(id, userId) as CredentialRow | undefined;
    if (!row) throw AppError.notFound("Credencial no encontrada.");
    return row;
  }

  #decrypt(row: CredentialRow): ProviderCredentialPayload {
    try {
      return this.crypto.decrypt(
        { userId: row.user_id, providerId: row.provider_id },
        {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.auth_tag,
          keyVersion: row.key_version,
        },
      );
    } catch (cause) {
      this.#markInvalid(row.id, row.user_id);
      throw appErrorWithCause(
        "PROVIDER_CREDENTIAL_INVALID",
        "La credencial guardada no se puede utilizar. Volve a conectarla.",
        500,
        cause,
      );
    }
  }

  #markInvalid(id: string, userId: string): void {
    this.database.sqlite
      .prepare("UPDATE provider_credentials SET status = 'invalid', updated_at = ? WHERE id = ? AND user_id = ?")
      .run(this.now(), id, userId);
  }
}

function safeCredential(row: CredentialRow): SafeProviderCredential {
  return {
    id: row.id,
    providerId: row.provider_id,
    authType: row.auth_type,
    label: row.label,
    lastFour: row.last_four,
    status: row.status,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
  };
}

function appErrorWithCause(code: string, message: string, statusCode: number, cause: unknown): AppError {
  const error = new AppError(code, message, statusCode);
  Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  return error;
}
