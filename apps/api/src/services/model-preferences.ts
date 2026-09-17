import { randomUUID } from "node:crypto";

import type { DatabaseConnection } from "../db/client.ts";
import { AppError } from "../errors.ts";
import type { ProviderCatalogService } from "./provider-catalog.ts";
import type { ProviderCredentialService } from "./provider-credentials.ts";

export interface ModelPreferenceInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly smallModelId?: string | null;
}

export interface ModelPreference extends ModelPreferenceInput {
  readonly id: string;
  readonly repositoryId: string | null;
}

interface PreferenceRow {
  id: string;
  repository_id: string | null;
  provider_id: string;
  model_id: string;
  small_model_id: string | null;
}

export class ModelPreferenceService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly credentials: ProviderCredentialService,
    private readonly catalog: ProviderCatalogService,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * La preferencia global, o `null` si el usuario todavia no eligio modelo.
   * El onboarding la necesita para rehidratarse: sin esto, al recargar no hay
   * forma de saber si el paso 1 quedo terminado o a medias.
   */
  getGlobal(userId: string): ModelPreference | null {
    const row = this.database.sqlite
      .prepare(
        `SELECT id, repository_id, provider_id, model_id, small_model_id
         FROM user_model_preferences
         WHERE user_id = ? AND repository_id IS NULL`,
      )
      .get(userId) as PreferenceRow | undefined;
    return row ? preferenceBody(row) : null;
  }

  async setGlobal(userId: string, input: ModelPreferenceInput): Promise<ModelPreference> {
    await this.#validate(userId, input);
    return this.#upsert(userId, null, input);
  }

  async setForRepository(
    userId: string,
    repositoryId: string,
    input: ModelPreferenceInput,
  ): Promise<ModelPreference> {
    const repository = this.database.sqlite
      .prepare("SELECT id FROM repositories WHERE id = ? AND user_id = ? AND unlinked_at IS NULL")
      .get(repositoryId, userId);
    if (!repository) throw AppError.notFound("Repositorio no encontrado.");
    await this.#validate(userId, input);
    return this.#upsert(userId, repositoryId, input);
  }

  #upsert(userId: string, repositoryId: string | null, input: ModelPreferenceInput): ModelPreference {
    const existing = this.database.sqlite.prepare(
      repositoryId === null
        ? "SELECT id FROM user_model_preferences WHERE user_id = ? AND repository_id IS NULL"
        : "SELECT id FROM user_model_preferences WHERE user_id = ? AND repository_id = ?",
    ).get(...(repositoryId === null ? [userId] : [userId, repositoryId])) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const now = this.now();
    if (existing) {
      this.database.sqlite.prepare(
        `UPDATE user_model_preferences
         SET provider_id = ?, model_id = ?, small_model_id = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      ).run(input.providerId, input.modelId, input.smallModelId ?? null, now, id, userId);
    } else {
      this.database.sqlite.prepare(
        `INSERT INTO user_model_preferences
          (id, user_id, repository_id, provider_id, model_id, small_model_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        userId,
        repositoryId,
        input.providerId,
        input.modelId,
        input.smallModelId ?? null,
        now,
        now,
      );
    }
    const row = this.database.sqlite
      .prepare("SELECT id, repository_id, provider_id, model_id, small_model_id FROM user_model_preferences WHERE id = ?")
      .get(id) as PreferenceRow;
    return preferenceBody(row);
  }

  async #validate(userId: string, input: ModelPreferenceInput): Promise<void> {
    this.credentials.getActive(userId, input.providerId);
    await this.catalog.assertUsableModel(input.providerId, input.modelId);
    if (input.smallModelId) await this.catalog.assertUsableModel(input.providerId, input.smallModelId);
  }
}

function preferenceBody(row: PreferenceRow): ModelPreference {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    smallModelId: row.small_model_id,
  };
}
