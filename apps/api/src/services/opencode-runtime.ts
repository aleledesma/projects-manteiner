import { randomBytes, randomUUID } from "node:crypto";

import { createOpencodeClient } from "@opencode-ai/sdk";
import Dockerode from "dockerode";

import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";
import type { ProviderCredentialPayload } from "./credential-crypto.ts";
import type { CatalogModel, CatalogProvider, OpencodeProviderRuntime } from "./provider-catalog.ts";

interface OpencodeContainer {
  start(options?: Dockerode.ContainerStartOptions): Promise<unknown>;
  inspect(options?: { abortSignal?: AbortSignal }): Promise<Dockerode.ContainerInspectInfo>;
  remove(options: Dockerode.ContainerRemoveOptions & { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface OpencodeDockerClient {
  createContainer(options: Dockerode.ContainerCreateOptions): Promise<OpencodeContainer>;
  getContainer(name: string): OpencodeContainer;
}

export class DockerOpencodeRuntime implements OpencodeProviderRuntime {
  readonly #client: OpencodeDockerClient;

  constructor(
    private readonly config: Config,
    client?: OpencodeDockerClient,
    private readonly hostFetch: typeof fetch = globalThis.fetch,
  ) {
    this.#client = client ?? new Dockerode({
      ...(config.DOCKER_SOCKET ? { socketPath: config.DOCKER_SOCKET } : {}),
    });
  }

  async getCatalog(
    credential?: { providerId: string; payload: ProviderCredentialPayload },
  ): Promise<CatalogProvider[]> {
    return this.#withServer(async (client) => {
      if (credential) {
        await client.auth.set({
          path: { id: credential.providerId },
          body: credential.payload as never,
        });
      }
      const response = await client.config.providers();
      const data = unwrap(response) as { providers?: unknown[] } | undefined;
      return normalizeProviders(data?.providers);
    });
  }

  async validateApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.#withServer(async (client) => {
      try {
        await client.auth.set({ path: { id: providerId }, body: { type: "api", key: apiKey } });
        const catalogResponse = await client.config.providers();
        const catalog = normalizeProviders(
          (unwrap(catalogResponse) as { providers?: unknown[] } | undefined)?.providers,
        );
        const provider = catalog.find((candidate) => candidate.id === providerId);
        const model = cheapestModel(provider?.models ?? []);
        if (!model) {
          throw new AppError(
            "MODEL_NOT_USABLE",
            "El proveedor no ofrece modelos compatibles con herramientas.",
            422,
          );
        }
        const session = unwrap(await client.session.create({ body: { title: "manteiner-provider-check" } })) as
          | { id?: string }
          | undefined;
        if (!session?.id) throw new Error("opencode no devolvio una sesion");
        const result = await client.session.prompt({
          path: { id: session.id },
          body: {
            model: { providerID: providerId, modelID: model.id },
            parts: [{ type: "text", text: "Responde solamente OK." }],
          } as never,
        });
        const info = (unwrap(result) as { info?: { error?: unknown } } | undefined)?.info;
        if (info?.error) throw new Error("el proveedor rechazo el prompt de validacion");
      } catch (cause) {
        if (cause instanceof AppError) throw cause;
        throw new AppError(
          "PROVIDER_AUTH_FAILED",
          "La credencial fue rechazada por el proveedor.",
          422,
        );
      }
    });
  }

  async #withServer<T>(use: (client: ReturnType<typeof createOpencodeClient>) => Promise<T>): Promise<T> {
    const name = `manteiner-catalog-${randomUUID()}`;
    const password = randomBytes(32).toString("base64url");
    let container: OpencodeContainer | undefined;
    let operationError: unknown;
    let result!: T;
    try {
      try {
        container = await this.#dockerCall((abortSignal) => this.#client.createContainer({
          name,
          Image: this.config.AGENT_IMAGE,
          Cmd: ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"],
          Env: [`OPENCODE_SERVER_PASSWORD=${password}`],
          ExposedPorts: { "4096/tcp": {} },
          Labels: { "manteiner.kind": "provider-catalog" },
          HostConfig: {
            AutoRemove: false,
            PortBindings: { "4096/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            Memory: 512 * 1024 ** 2,
            NanoCpus: 5e8,
            PidsLimit: 128,
            ReadonlyRootfs: true,
            Tmpfs: {
              "/tmp": "rw,noexec,nosuid,size=32m,mode=1777",
              "/home/opencode/.config/opencode": "rw,noexec,nosuid,size=16m,uid=10001,gid=10001,mode=700",
              "/home/opencode/.local/state/opencode": "rw,noexec,nosuid,size=16m,uid=10001,gid=10001,mode=700",
              "/home/opencode/.local/share/opencode": "rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=700",
              "/home/opencode/.cache/opencode": "rw,noexec,nosuid,size=128m,uid=10001,gid=10001,mode=700",
            },
          },
          abortSignal,
        }));
      } catch (cause) {
        await this.#bestEffortRemoveContainer(name);
        if (dockerStatusCode(cause) === 404) {
          throw new AppError("IMAGE_MISSING", `No se encontro la imagen Docker ${this.config.AGENT_IMAGE}.`, 503);
        }
        throw cause;
      }
      await this.#dockerCall((abortSignal) => container!.start({ abortSignal }));
      const inspect = await this.#dockerCall((abortSignal) => container!.inspect({ abortSignal }));
      const hostPort = inspect.NetworkSettings.Ports?.["4096/tcp"]?.[0]?.HostPort;
      if (!hostPort) throw new Error("Docker no publico el puerto de opencode");
      const baseUrl = `http://127.0.0.1:${hostPort}`;
      const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
      const operationController = new AbortController();
      const authenticatedFetch: typeof fetch = (input, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", authorization);
        const signals = [operationController.signal];
        if (init.signal) signals.push(init.signal);
        return this.hostFetch(input, {
          ...init,
          headers,
          signal: AbortSignal.any(signals),
        });
      };
      await this.#waitUntilReady(baseUrl, authenticatedFetch);
      result = await withDeadline(
        use(createOpencodeClient({ baseUrl, fetch: authenticatedFetch })),
        this.config.PROVIDER_OPERATION_TIMEOUT_MS,
        new AppError("PROVIDER_OPERATION_TIMEOUT", "La operacion con el proveedor excedio el tiempo limite.", 504),
        () => operationController.abort(),
      );
    } catch (cause) {
      operationError = cause;
    }

    if (container) {
      try {
        await this.#dockerCall((abortSignal) => container!.remove({ force: true, v: true, abortSignal }));
      } catch {
        throw new AppError(
          "PROVIDER_CONTAINER_CLEANUP_FAILED",
          "No se pudo eliminar el contenedor temporal del proveedor.",
          500,
        );
      }
    }
    if (operationError !== undefined) {
      if (operationError instanceof AppError) throw operationError;
      throw new AppError(
        "PROVIDER_RUNTIME_FAILED",
        "No se pudo ejecutar la verificacion del proveedor.",
        502,
      );
    }
    return result;
  }

  async #waitUntilReady(baseUrl: string, authenticatedFetch: typeof fetch): Promise<void> {
    const deadline = Date.now() + this.config.PROVIDER_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const controller = new AbortController();
        const response = await withDeadline(
          authenticatedFetch(`${baseUrl}/path`, { signal: controller.signal }),
          Math.min(this.config.PROVIDER_HTTP_TIMEOUT_MS, Math.max(deadline - Date.now(), 1)),
          new AppError("PROVIDER_RUNTIME_TIMEOUT", "opencode no inicio a tiempo.", 504),
          () => controller.abort(),
        );
        if (response.ok) {
          await response.body?.cancel();
          return;
        }
        await response.body?.cancel();
      } catch {
        // The container is still starting.
      }
      await delay(250);
    }
    throw new AppError("PROVIDER_RUNTIME_TIMEOUT", "opencode no inicio a tiempo.", 504);
  }

  #dockerCall<T>(operation: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    return withDeadline(
      operation(controller.signal),
      this.config.DOCKER_API_TIMEOUT_MS,
      new AppError("DOCKER_API_TIMEOUT", "Docker no respondio a tiempo.", 503),
      () => controller.abort(),
    );
  }

  async #bestEffortRemoveContainer(name: string): Promise<void> {
    for (const delayMs of [0, 100, 500, 1_000]) {
      if (delayMs > 0) await delay(delayMs);
      try {
        await this.#dockerCall((abortSignal) =>
          this.#client.getContainer(name).remove({ force: true, v: true, abortSignal }),
        );
        return;
      } catch {
        // A timed-out create may become visible shortly after the client aborts.
      }
    }
  }
}

function normalizeProviders(raw: unknown[] | undefined): CatalogProvider[] {
  if (!Array.isArray(raw)) throw new Error("catalogo de opencode invalido");
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const provider = value as Record<string, unknown>;
    if (typeof provider["id"] !== "string") return [];
    const rawModels = provider["models"];
    if (!rawModels || typeof rawModels !== "object") return [];
    const models = Object.values(rawModels as Record<string, unknown>).flatMap(normalizeModel);
    return [{
      id: provider["id"],
      name: typeof provider["name"] === "string" ? provider["name"] : provider["id"],
      models,
    }];
  });
}

function normalizeModel(value: unknown): CatalogModel[] {
  if (!value || typeof value !== "object") return [];
  const model = value as Record<string, unknown>;
  const capabilities = model["capabilities"];
  if (
    typeof model["id"] !== "string" ||
    !capabilities ||
    typeof capabilities !== "object" ||
    (capabilities as Record<string, unknown>)["toolcall"] !== true
  ) return [];
  return [{
    id: model["id"],
    name: typeof model["name"] === "string" ? model["name"] : model["id"],
    capabilities: { ...(capabilities as Record<string, unknown>), toolcall: true },
    ...(typeof model["status"] === "string" ? { status: model["status"] } : {}),
    ...(model["limit"] && typeof model["limit"] === "object" ? { limit: model["limit"] } : {}),
    ...(model["cost"] && typeof model["cost"] === "object" ? { cost: model["cost"] } : {}),
  } as CatalogModel];
}

function cheapestModel(models: CatalogModel[]): CatalogModel | undefined {
  return [...models].sort((a, b) => modelCost(a) - modelCost(b) || a.id.localeCompare(b.id))[0];
}

function modelCost(model: CatalogModel): number {
  if (!model.cost) return Number.POSITIVE_INFINITY;
  return model.cost.input + model.cost.output;
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) return (value as { data: unknown }).data;
  return value;
}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: AppError,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(timeoutError);
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dockerStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}
