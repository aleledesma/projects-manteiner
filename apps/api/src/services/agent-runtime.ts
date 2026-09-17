/**
 * Contenedor 2 del run: el agente.
 *
 * Monta el volumen del clon, levanta opencode sin credenciales, se las entrega
 * por `auth.set` (nunca por `Env`: eso aparece en `docker inspect`) y dirige la
 * sesion desde aca. El contenedor es una caja tonta; el prompt, el JSON Schema
 * y los reintentos viven en el host, donde se versionan y se testean (doc 05).
 *
 * No recibe token de GitHub. No es configuracion: es que no existe en su
 * entorno, asi que un README malicioso no tiene nada que robar.
 */

import { randomBytes } from "node:crypto";

import { buildMaintenancePrompt, buildMaintenanceReportJsonSchema } from "@manteiner/contracts";
import { createOpencodeClient } from "@opencode-ai/sdk";
import Dockerode from "dockerode";

import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";
import type { ProviderCredentialPayload } from "./credential-crypto.ts";
import {
  delay,
  demultiplexDockerStream,
  dockerStatusCode,
  MANTEINER_LABEL,
  RUN_LABEL,
  withDeadline,
} from "./docker-helpers.ts";

export interface AgentRunInput {
  readonly runId: string;
  readonly userId: string;
  readonly volumeName: string;
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly credential: ProviderCredentialPayload;
  /** Cancelacion del usuario o apagado de la API. */
  readonly signal?: AbortSignal;
}

export interface AgentRunOutput {
  /** El objeto crudo del structured output, sin validar todavia. */
  readonly structured: unknown;
  readonly sessionId: string;
  readonly containerId: string;
  readonly diff: string;
  readonly tokensInput: number | null;
  readonly tokensOutput: number | null;
  readonly costUsd: number | null;
}

interface AgentContainer {
  readonly id: string;
  start(options?: Dockerode.ContainerStartOptions): Promise<unknown>;
  inspect(options?: { abortSignal?: AbortSignal }): Promise<Dockerode.ContainerInspectInfo>;
  remove(options: Dockerode.ContainerRemoveOptions & { abortSignal?: AbortSignal }): Promise<unknown>;
  logs(options: Dockerode.ContainerLogsOptions & { follow?: false }): Promise<Buffer>;
  exec(options: Dockerode.ExecCreateOptions): Promise<AgentExec>;
}

interface AgentExec {
  start(options: { hijackedStream?: boolean; stdin?: boolean }): Promise<NodeJS.ReadableStream>;
  inspect(): Promise<{ ExitCode: number | null }>;
}

export interface AgentDockerClient {
  createContainer(options: Dockerode.ContainerCreateOptions): Promise<AgentContainer>;
  getContainer(name: string): AgentContainer;
}

export interface AgentRuntime {
  run(input: AgentRunInput): Promise<AgentRunOutput>;
}

export class DockerAgentRuntime implements AgentRuntime {
  readonly #client: AgentDockerClient;

  constructor(
    private readonly config: Config,
    client?: AgentDockerClient,
    private readonly hostFetch: typeof fetch = globalThis.fetch,
  ) {
    this.#client = client ?? (new Dockerode({
      ...(config.DOCKER_SOCKET ? { socketPath: config.DOCKER_SOCKET } : {}),
    }) as unknown as AgentDockerClient);
  }

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const name = `manteiner-agent-${input.runId}`;
    const password = randomBytes(32).toString("base64url");
    let container: AgentContainer | undefined;
    let operationError: unknown;
    let result!: AgentRunOutput;

    try {
      container = await this.#crearContenedor(name, password, input);
      await this.#dockerCall((abortSignal) => container!.start({ abortSignal }));

      const inspect = await this.#dockerCall((abortSignal) => container!.inspect({ abortSignal }));
      const hostPort = inspect.NetworkSettings.Ports?.["4096/tcp"]?.[0]?.HostPort;
      if (!hostPort) throw new AppError("CONTAINER_START_TIMEOUT", "Docker no publico el puerto del agente.", 502);

      const baseUrl = `http://127.0.0.1:${hostPort}`;
      const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
      const runController = new AbortController();
      const abortarRun = () => runController.abort();
      input.signal?.addEventListener("abort", abortarRun, { once: true });

      const authenticatedFetch: typeof fetch = (url, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", authorization);
        const signals = [runController.signal];
        if (init.signal) signals.push(init.signal);
        return this.hostFetch(url, { ...init, headers, signal: AbortSignal.any(signals) });
      };

      try {
        await this.#esperarOpencode(baseUrl, authenticatedFetch, container!);
        result = await withDeadline(
          this.#dirigirSesion(baseUrl, authenticatedFetch, container!, input),
          this.config.RUN_TIMEOUT_MS,
          new AppError("RUN_TIMEOUT", "La auditoria excedio el tiempo maximo.", 504),
          abortarRun,
        );
      } finally {
        input.signal?.removeEventListener("abort", abortarRun);
      }
    } catch (error) {
      operationError = await this.#enriquecerError(error, container);
    }

    // El contenedor se borra siempre. Si falla el borrado, eso pisa el error
    // original: un contenedor vivo con el repo montado es peor que un run fallido.
    if (container) {
      try {
        await this.#dockerCall((abortSignal) => container!.remove({ force: true, v: true, abortSignal }));
      } catch {
        throw new AppError(
          "AGENT_CONTAINER_CLEANUP_FAILED",
          "No se pudo eliminar el contenedor del agente.",
          500,
        );
      }
    }

    if (operationError !== undefined) throw operationError;
    return result;
  }

  async #crearContenedor(
    name: string,
    password: string,
    input: AgentRunInput,
  ): Promise<AgentContainer> {
    const prompt = buildMaintenancePrompt({
      owner: input.owner,
      repo: input.repository,
      branch: input.branch,
      sha: input.baseSha,
    });

    try {
      return await this.#dockerCall((abortSignal) => this.#client.createContainer({
        name,
        Image: this.config.AGENT_IMAGE,
        Cmd: ["bun", "run", "/opt/runner/index.ts"],
        WorkingDir: "/work/repo",
        Labels: { [MANTEINER_LABEL]: "agent", [RUN_LABEL]: input.runId, "manteiner.user": input.userId },
        Env: [
          `MANTEINER_RUN_ID=${input.runId}`,
          `MANTEINER_MODEL=${input.providerId}/${input.modelId}`,
          `MANTEINER_PROMPT_B64=${Buffer.from(prompt, "utf8").toString("base64")}`,
          `OPENCODE_SERVER_PASSWORD=${password}`,
        ],
        ExposedPorts: { "4096/tcp": {} },
        HostConfig: {
          Mounts: [{ Type: "volume", Source: input.volumeName, Target: "/work" }],
          PortBindings: { "4096/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
          Tmpfs: { "/tmp": "rw,nosuid,size=256m" },
          Memory: this.config.AGENT_MEMORY_MB * 1024 ** 2,
          MemorySwap: this.config.AGENT_MEMORY_MB * 1024 ** 2,
          NanoCpus: Math.round(this.config.AGENT_CPUS * 1e9),
          PidsLimit: 512,
          Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 8192 }],
          Privileged: false,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          AutoRemove: false,
        },
        abortSignal,
      }));
    } catch (cause) {
      await this.#borrarPorNombre(name);
      if (dockerStatusCode(cause) === 404) {
        throw new AppError("IMAGE_MISSING", `No se encontro la imagen Docker ${this.config.AGENT_IMAGE}.`, 503);
      }
      throw cause;
    }
  }

  /**
   * Healthcheck con backoff. Si el contenedor muere mientras esperamos, corta
   * enseguida en vez de agotar el timeout completo contra un puerto muerto.
   */
  async #esperarOpencode(
    baseUrl: string,
    authenticatedFetch: typeof fetch,
    container: AgentContainer,
  ): Promise<void> {
    const deadline = Date.now() + this.config.CONTAINER_START_TIMEOUT_MS;
    let espera = 150;

    while (Date.now() < deadline) {
      try {
        const controller = new AbortController();
        const response = await withDeadline(
          authenticatedFetch(`${baseUrl}/path`, { signal: controller.signal }),
          Math.min(this.config.PROVIDER_HTTP_TIMEOUT_MS, Math.max(deadline - Date.now(), 1)),
          new AppError("CONTAINER_START_TIMEOUT", "opencode no inicio a tiempo.", 504),
          () => controller.abort(),
        );
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        // Todavia arrancando.
      }

      const estado = await this.#dockerCall((abortSignal) => container.inspect({ abortSignal }));
      if (!estado.State.Running) {
        throw new AppError(
          estado.State.OOMKilled ? "CONTAINER_OOM" : "CONTAINER_START_TIMEOUT",
          estado.State.OOMKilled
            ? "El contenedor del agente se quedo sin memoria al arrancar."
            : "El contenedor del agente murio antes de responder.",
          502,
        );
      }

      await delay(espera);
      espera = Math.min(espera * 2, 2_000);
    }

    throw new AppError("CONTAINER_START_TIMEOUT", "opencode no inicio a tiempo.", 504);
  }

  async #dirigirSesion(
    baseUrl: string,
    authenticatedFetch: typeof fetch,
    container: AgentContainer,
    input: AgentRunInput,
  ): Promise<AgentRunOutput> {
    const client = createOpencodeClient({ baseUrl, fetch: authenticatedFetch });

    // La credencial entra por HTTP, ya con el servidor arriba (I4). Nunca pasa
    // por `Env`, asi que no queda en `docker inspect` ni en /proc.
    try {
      await client.auth.set({ path: { id: input.providerId }, body: input.credential as never });
    } catch {
      // Sin encadenar `cause`: el error del SDK puede retener el body enviado.
      throw new AppError("PROVIDER_AUTH_FAILED", "El proveedor rechazo la credencial.", 422);
    }

    let session: { id?: string } | undefined;
    try {
      session = unwrap(
        await client.session.create({ body: { title: `manteiner-${input.runId}` } }),
      ) as { id?: string } | undefined;
    } catch (cause) {
      throw new AppError(
        "AGENT_SESSION_FAILED",
        `opencode no pudo crear la sesion: ${mensajeDe(cause)}`,
        502,
      );
    }
    if (!session?.id) throw new AppError("AGENT_SESSION_FAILED", "opencode no devolvio una sesion.", 502);

    const schema = buildMaintenanceReportJsonSchema();
    let respuesta: unknown;
    try {
      respuesta = await client.session.prompt({
        path: { id: session.id },
        body: {
          model: { providerID: input.providerId, modelID: input.modelId },
          parts: [{ type: "text", text: PEDIDO }],
          format: { type: "json_schema", schema } as never,
        } as never,
      });
    } catch (cause) {
      // Antes esto salia como INTERNAL_ERROR sin mensaje: un fallo del SDK o del
      // proveedor a mitad de la sesion era indistinguible de un bug nuestro.
      throw new AppError("AGENT_FAILED", `La sesion del agente fallo: ${mensajeDe(cause)}`, 502);
    }

    const info = (unwrap(respuesta) as { info?: Record<string, unknown> } | undefined)?.info;
    if (info?.["error"]) throw errorDelProveedor(info["error"]);

    // El campo real es `structured`, NO `structured_output` como dice la doc de
    // opencode. El fallback queda por si cambia entre versiones (doc 13).
    const structured = info?.["structured"] ?? info?.["structured_output"];
    if (structured === undefined || structured === null) {
      throw new AppError("SCHEMA_INVALID", "El agente no devolvio structured output.", 422);
    }

    return {
      structured,
      sessionId: session.id,
      containerId: container.id,
      diff: await this.#capturarDiff(container),
      ...leerConsumo(info),
    };
  }

  /**
   * El diff sale de un `exec`, no de montar nada: solo cruza texto al proceso
   * de la API. Se excluye `.opencode/` por si el repo auditado ya lo versionaba.
   */
  async #capturarDiff(container: AgentContainer): Promise<string> {
    try {
      const exec = await container.exec({
        Cmd: ["git", "-C", "/work/repo", "diff", "--", ".", ":(exclude).opencode"],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijackedStream: true });
      const trozos: Buffer[] = [];
      for await (const trozo of stream) trozos.push(Buffer.from(trozo as Buffer));
      const { ExitCode } = await exec.inspect();
      if (ExitCode !== 0) return "";
      return demultiplexDockerStream(Buffer.concat(trozos));
    } catch {
      // El informe vale sin diff; no se pierde un run de 20 minutos por esto.
      return "";
    }
  }

  /**
   * Enriquece un fallo con lo que solo se puede leer antes de borrar el
   * contenedor: si lo mato el OOM killer, y sus ultimas lineas de log.
   *
   * Los logs solo se adjuntan en runs fallidos (doc 05) y pueden contener
   * fragmentos del repositorio: se borran junto con el run.
   */
  async #enriquecerError(error: unknown, container: AgentContainer | undefined): Promise<unknown> {
    if (!container) return error;

    let oom = false;
    try {
      const estado = await this.#dockerCall((abortSignal) => container.inspect({ abortSignal }));
      oom = estado.State.OOMKilled === true;
    } catch {
      // Si no se puede inspeccionar, vale lo que ya sabemos.
    }

    const logs = await this.#ultimasLineas(container);
    if (oom) {
      return new AppError(
        "CONTAINER_OOM",
        `El contenedor del agente se quedo sin memoria (limite ${this.config.AGENT_MEMORY_MB} MB).`,
        502,
        { logs },
      );
    }
    if (error instanceof AppError) {
      return new AppError(error.code, error.message, error.statusCode, {
        ...(typeof error.details === "object" && error.details ? error.details : {}),
        logs,
      });
    }
    return new AppError("AGENT_FAILED", mensajeDe(error), 502, { logs });
  }

  /** Cola del log del contenedor, para que un fallo sea diagnosticable. */
  async #ultimasLineas(container: AgentContainer): Promise<string[]> {
    try {
      const crudo = await this.#dockerCall(() =>
        container.logs({ stdout: true, stderr: true, tail: 40, follow: false }),
      );
      return demultiplexDockerStream(Buffer.from(crudo))
        .split(/\r?\n/)
        .map((linea) => linea.trimEnd())
        .filter((linea) => linea.length > 0)
        .slice(-40);
    } catch {
      return [];
    }
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

  async #borrarPorNombre(name: string): Promise<void> {
    for (const espera of [0, 100, 500, 1_000]) {
      if (espera > 0) await delay(espera);
      try {
        await this.#dockerCall((abortSignal) =>
          this.#client.getContainer(name).remove({ force: true, v: true, abortSignal }),
        );
        return;
      } catch {
        // Un create que expiro puede hacerse visible poco despues del abort.
      }
    }
  }
}

/**
 * El pedido concreto. Las instrucciones viven en el system prompt del agente,
 * que el runner escribio en `maintainer.md`: repetirlas aca las duplicaria y
 * abriria la puerta a que diverjan.
 */
const PEDIDO =
  "Auditá este repositorio siguiendo tus instrucciones y devolvé el informe en el formato pedido.";

function leerConsumo(info: Record<string, unknown> | undefined): {
  tokensInput: number | null;
  tokensOutput: number | null;
  costUsd: number | null;
} {
  const tokens = info?.["tokens"] as { input?: unknown; output?: unknown } | undefined;
  const costo = info?.["cost"];
  return {
    tokensInput: typeof tokens?.input === "number" ? tokens.input : null,
    tokensOutput: typeof tokens?.output === "number" ? tokens.output : null,
    // Con suscripcion opencode informa 0: eso no es un costo real, es "no sabe".
    costUsd: typeof costo === "number" && costo > 0 ? costo : null,
  };
}

function errorDelProveedor(error: unknown): AppError {
  const nombre = typeof error === "object" && error && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
  if (/rate.?limit/i.test(nombre)) {
    return new AppError("PROVIDER_RATE_LIMIT", "El proveedor limito la tasa de pedidos.", 429);
  }
  if (/auth|credential|unauthor/i.test(nombre)) {
    return new AppError("PROVIDER_AUTH_FAILED", "El proveedor rechazo la credencial.", 422);
  }
  return new AppError("AGENT_FAILED", "El agente no pudo completar la auditoria.", 502);
}

function mensajeDe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error).slice(0, 300);
  } catch {
    return "error desconocido";
  }
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) return (value as { data: unknown }).data;
  return value;
}
