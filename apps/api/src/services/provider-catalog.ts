import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { AppError } from "../errors.ts";
import type { ProviderCredentialPayload } from "./credential-crypto.ts";

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string().optional(),
  capabilities: z.object({ toolcall: z.literal(true) }).passthrough(),
  limit: z.object({
    context: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
  }).passthrough().optional(),
  cost: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cache: z.object({
      read: z.number().nonnegative(),
      write: z.number().nonnegative(),
    }).optional(),
  }).passthrough().optional(),
});

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  models: z.array(modelSchema),
});

const catalogSchema = z.object({
  refreshedAt: z.number().int().nonnegative(),
  providers: z.array(providerSchema),
});

/**
 * Cache en disco, una entrada por proveedor.
 *
 * Es por proveedor y no un unico catalogo porque `config.providers()` solo
 * expone los proveedores que esa corrida tiene configurados: sin credencial
 * devuelve uno solo. Guardar la respuesta entera pisaba lo que habia aprendido
 * una corrida anterior con otra credencial, y con varios usuarios eso degenera
 * en un contenedor por visita, cada uno borrando lo del anterior.
 */
const cacheFileSchema = z.object({
  version: z.literal(2),
  entries: z.record(
    z.string(),
    z.object({ refreshedAt: z.number().int().nonnegative(), provider: providerSchema }),
  ),
});

type CacheFile = z.infer<typeof cacheFileSchema>;

export type ProviderCatalog = z.infer<typeof catalogSchema>;
export type CatalogProvider = z.infer<typeof providerSchema>;
export type CatalogModel = z.infer<typeof modelSchema>;

export interface OpencodeProviderRuntime {
  getCatalog(credential?: { providerId: string; payload: ProviderCredentialPayload }): Promise<CatalogProvider[]>;
  validateApiKey(providerId: string, apiKey: string): Promise<void>;
}

export class ProviderCatalogService {
  readonly #runtime: OpencodeProviderRuntime;
  readonly #cachePath: string;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #defaultCredential?: () => { providerId: string; payload: ProviderCredentialPayload } | undefined;
  /** Una promesa en vuelo por proveedor: dos usuarios no levantan dos contenedores. */
  readonly #refreshing = new Map<string, Promise<ProviderCatalog>>();
  /** Serializa el read-modify-write del archivo entre refrescos concurrentes. */
  #escritura: Promise<unknown> = Promise.resolve();
  #refreshTimer?: NodeJS.Timeout;

  constructor(options: {
    runtime: OpencodeProviderRuntime;
    cachePath: string;
    maxAgeMs: number;
    now?: () => number;
    defaultCredential?: () => { providerId: string; payload: ProviderCredentialPayload } | undefined;
  }) {
    this.#runtime = options.runtime;
    this.#cachePath = options.cachePath;
    this.#maxAgeMs = options.maxAgeMs;
    this.#now = options.now ?? Date.now;
    this.#defaultCredential = options.defaultCredential;
  }

  /**
   * Nunca levanta un contenedor si hay algo cacheado: sirve lo que tiene y, si
   * esta vencido, refresca en background. Solo el arranque en frio espera.
   */
  async get(): Promise<ProviderCatalog> {
    const cache = await this.#readCache();
    const catalogo = toCatalog(cache);
    if (!catalogo) return this.refresh();
    if (catalogo.refreshedAt + this.#maxAgeMs <= this.#now()) {
      void this.refresh().catch(() => {
        // A stale valid cache remains usable while Docker or the provider is unavailable.
      });
    }
    return catalogo;
  }

  async refresh(
    credential?: { providerId: string; payload: ProviderCredentialPayload },
  ): Promise<ProviderCatalog> {
    const usada = credential ?? this.#defaultCredential?.();
    const clave = usada?.providerId ?? "anonimo";
    const enVuelo = this.#refreshing.get(clave);
    if (enVuelo) return enVuelo;

    const corrida = this.#doRefresh(usada);
    this.#refreshing.set(clave, corrida);
    try {
      return await corrida;
    } finally {
      this.#refreshing.delete(clave);
    }
  }

  async validateApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.#runtime.validateApiKey(providerId, apiKey);
  }

  start(onError: (error: unknown) => void): void {
    if (this.#refreshTimer) return;
    void this.refresh().catch(onError);
    this.#refreshTimer = setInterval(() => {
      void this.refresh().catch(onError);
    }, this.#maxAgeMs);
    this.#refreshTimer.unref();
  }

  async close(): Promise<void> {
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = undefined;
    try {
      await this.#refreshing;
    } catch {
      // Shutdown only waits for cleanup; refresh failures were already reported by the caller.
    }
  }

  async assertUsableModel(providerId: string, modelId: string): Promise<void> {
    const catalog = await this.get();
    const provider = catalog.providers.find((candidate) => candidate.id === providerId);
    if (!provider) throw new AppError("PROVIDER_NOT_FOUND", "El proveedor no existe en el catalogo.", 422);
    if (!provider.models.some((model) => model.id === modelId)) {
      throw new AppError(
        "MODEL_NOT_USABLE",
        "El modelo no pertenece al proveedor o no soporta tool calling.",
        422,
      );
    }
  }

  async #doRefresh(
    credential?: { providerId: string; payload: ProviderCredentialPayload },
  ): Promise<ProviderCatalog> {
    const providers = await this.#runtime.getCatalog(credential);
    return this.#fusionar(providers);
  }

  /**
   * Mezcla lo que devolvio esta corrida con lo ya cacheado. Un proveedor que
   * esta corrida no vio se conserva: su ausencia significa "no estaba
   * configurado aca", no "dejo de existir".
   */
  #fusionar(providers: CatalogProvider[]): Promise<ProviderCatalog> {
    const paso = this.#escritura.then(async () => {
      const cache: CacheFile = (await this.#readCache()) ?? { version: 2, entries: {} };
      const refreshedAt = this.#now();
      for (const provider of providers) {
        cache.entries[provider.id] = { refreshedAt, provider };
      }
      await mkdir(dirname(this.#cachePath), { recursive: true });
      const temporary = `${this.#cachePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#cachePath);
      return toCatalog(cache) ?? { refreshedAt, providers: [] };
    });
    // La cola no se corta si un refresco falla.
    this.#escritura = paso.catch(() => {});
    return paso;
  }

  async #readCache(): Promise<CacheFile | undefined> {
    try {
      // Un archivo con el formato viejo se descarta: se reconstruye solo.
      return cacheFileSchema.parse(JSON.parse(await readFile(this.#cachePath, "utf8")));
    } catch {
      return undefined;
    }
  }
}

/**
 * Vista publica del cache. `refreshedAt` es el de la entrada mas vieja: si un
 * proveedor quedo sin actualizar, el catalogo entero cuenta como viejo.
 */
function toCatalog(cache: CacheFile | undefined): ProviderCatalog | undefined {
  const entradas = Object.values(cache?.entries ?? {});
  if (entradas.length === 0) return undefined;
  return {
    refreshedAt: Math.min(...entradas.map((entrada) => entrada.refreshedAt)),
    providers: entradas
      .map((entrada) => entrada.provider)
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
