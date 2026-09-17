import { Readable, Writable } from "node:stream";

import Dockerode from "dockerode";
import { z } from "zod";

import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";
import type { GithubCloneRepository } from "./github-app.ts";

const cloneResultSchema = z.object({
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  sizeKb: z.number().int().nonnegative(),
});

export interface RepositoryCloneInput {
  runId: string;
  installationId: number;
  githubRepositoryId: number;
}

export interface ClonedWorkspace {
  volumeName: string;
  baseSha: string;
  sizeKb: number;
}

export interface CloneGithubClient {
  createCloneToken(installationId: number, repositoryId: number): Promise<string>;
  getRepositoryForClone(token: string, repositoryId: number): Promise<GithubCloneRepository>;
  revokeInstallationToken(token: string): Promise<void>;
}

export interface WorkspaceRuntime {
  createVolume(runId: string): Promise<string>;
  cloneRepository(
    input: {
      runId: string;
      owner: string;
      repository: string;
      branch: string;
      volumeName: string;
      token: string;
    },
  ): Promise<Omit<ClonedWorkspace, "volumeName">>;
  removeVolume(volumeName: string): Promise<void>;
}

export class RepositoryWorkspaceService {
  constructor(
    private readonly config: Config,
    private readonly github: CloneGithubClient,
    private readonly runtime: WorkspaceRuntime,
  ) {}

  async withClonedRepository<T>(
    input: RepositoryCloneInput,
    useWorkspace: (workspace: ClonedWorkspace) => Promise<T>,
  ): Promise<T> {
    const token = await this.github.createCloneToken(input.installationId, input.githubRepositoryId);
    let tokenRevoked = false;
    let volumeName: string | undefined;
    let result!: T;
    let operationError: unknown;

    try {
      const repository = await this.github.getRepositoryForClone(token, input.githubRepositoryId);
      if (repository.size > this.config.MAX_REPO_SIZE_KB) {
        throw new AppError(
          "WORKSPACE_TOO_LARGE",
          `El repositorio supera el limite de ${this.config.MAX_REPO_SIZE_KB} KB.`,
          422,
          { repositorySizeKb: repository.size, limitKb: this.config.MAX_REPO_SIZE_KB },
        );
      }

      volumeName = await this.runtime.createVolume(input.runId);
      const clone = await this.runtime.cloneRepository({
        runId: input.runId,
        volumeName,
        owner: repository.owner.login,
        repository: repository.name,
        branch: repository.default_branch,
        token,
      });
      await this.github.revokeInstallationToken(token);
      tokenRevoked = true;
      result = await useWorkspace({ volumeName, ...clone });
    } catch (error) {
      operationError = error;
    }

    const cleanupFailures: string[] = [];
    if (volumeName) {
      try {
        await this.runtime.removeVolume(volumeName);
      } catch {
        cleanupFailures.push("volume");
      }
    }
    if (!tokenRevoked) {
      try {
        await this.github.revokeInstallationToken(token);
      } catch {
        cleanupFailures.push("github_token");
      }
    }

    if (cleanupFailures.length > 0) throw cleanupError(cleanupFailures, operationError);
    if (operationError !== undefined) throw operationError;
    return result;
  }
}

interface CloneContainer {
  readonly modem: {
    demuxStream(
      stream: NodeJS.ReadableStream,
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
    ): void;
  };
  attach(options: Dockerode.ContainerAttachOptions): Promise<NodeJS.ReadWriteStream>;
  start(options?: Dockerode.ContainerStartOptions): Promise<unknown>;
  wait(options?: Dockerode.ContainerWaitOptions): Promise<{ StatusCode: number }>;
  logs(options: Dockerode.ContainerLogsOptions & { follow?: false }): Promise<Buffer>;
  remove(
    options: Dockerode.ContainerRemoveOptions & { abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

export interface WorkspaceDockerClient {
  createVolume(options: Dockerode.VolumeCreateOptions): Promise<{ Name: string }>;
  getVolume(name: string): { remove(options: Dockerode.VolumeRemoveOptions): Promise<unknown> };
  getContainer(name: string): CloneContainer;
  createContainer(options: Dockerode.ContainerCreateOptions): Promise<CloneContainer>;
}

export class DockerWorkspaceRuntime implements WorkspaceRuntime {
  private readonly client: WorkspaceDockerClient;

  constructor(
    private readonly config: Config,
    client?: WorkspaceDockerClient,
  ) {
    this.client =
      client ??
      new Dockerode({
        ...(config.DOCKER_SOCKET ? { socketPath: config.DOCKER_SOCKET } : {}),
      });
  }

  async createVolume(runId: string): Promise<string> {
    assertDockerNamePart(runId);
    const name = `manteiner-ws-${runId}`;
    try {
      await this.dockerApiCall((abortSignal) =>
        this.client.createVolume({
          Name: name,
          Driver: "local",
          Labels: { "manteiner.run": runId, "manteiner.kind": "workspace" },
          abortSignal,
        }),
      );
    } catch (error) {
      await this.bestEffortRemoveVolume(name, cleanupRetryDelays(error));
      throw error;
    }
    return name;
  }

  async cloneRepository(
    input: {
      runId: string;
      owner: string;
      repository: string;
      branch: string;
      volumeName: string;
      token: string;
    },
  ): Promise<Omit<ClonedWorkspace, "volumeName">> {
    let container: CloneContainer | undefined;
    let result: Omit<ClonedWorkspace, "volumeName"> | undefined;
    let operationError: unknown;
    const containerName = `manteiner-clone-${input.runId}`;

    try {
      try {
        container = await this.dockerApiCall((abortSignal) =>
          this.client.createContainer({
            name: containerName,
            Image: this.config.GIT_IMAGE,
            Cmd: ["/usr/local/bin/clone.sh", input.owner, input.repository, input.branch],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            OpenStdin: true,
            StdinOnce: true,
            Tty: false,
            Labels: { "manteiner.run": input.runId, "manteiner.kind": "clone" },
            HostConfig: {
              Mounts: [{ Type: "volume", Source: input.volumeName, Target: "/work" }],
              CapDrop: ["ALL"],
              SecurityOpt: ["no-new-privileges:true"],
              Memory: 1024 ** 3,
              NanoCpus: 1e9,
              PidsLimit: 128,
              ReadonlyRootfs: true,
              Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m,mode=1777" },
            },
            abortSignal,
          }),
        );
      } catch (error) {
        await this.bestEffortRemoveContainer(containerName, cleanupRetryDelays(error));
        if (dockerStatusCode(error) === 404) {
          throw new AppError(
            "IMAGE_MISSING",
            `No se encontro la imagen Docker ${this.config.GIT_IMAGE}.`,
            503,
          );
        }
        throw error;
      }

      result = await this.runCloneContainer(container, input.token);
    } catch (error) {
      operationError =
        error instanceof AppError
          ? error
          : appErrorWithCause("CLONE_FAILED", "No se pudo clonar el repositorio.", 502, error);
    }

    if (container) {
      try {
        await this.dockerApiCall((abortSignal) =>
          container!.remove({ force: true, v: false, abortSignal }),
        );
      } catch {
        throw cleanupError(["clone_container"], operationError);
      }
    }

    if (operationError !== undefined) throw operationError;
    return result!;
  }

  async removeVolume(volumeName: string): Promise<void> {
    await this.dockerApiCall((abortSignal) =>
      this.client.getVolume(volumeName).remove({ force: true, abortSignal }),
    );
  }

  private async runCloneContainer(
    container: CloneContainer,
    token: string,
  ): Promise<Omit<ClonedWorkspace, "volumeName">> {
    const stream = await this.dockerApiCall((abortSignal) =>
      container.attach({
        stream: true,
        stdin: true,
        hijack: true,
        abortSignal,
      }),
    );
    const streamError = new Promise<never>((_, reject) => stream.on("error", reject));

    await Promise.race([
      this.dockerApiCall((abortSignal) => container.start({ abortSignal })),
      streamError,
    ]);
    stream.end(`${token}\n`);

    const result = await Promise.race([
      withAbortDeadline(
        (abortSignal) => container.wait({ abortSignal }),
        this.config.CLONE_TIMEOUT_MS,
        new AppError("CLONE_TIMEOUT", "El clonado excedio el tiempo limite.", 504),
      ),
      streamError,
    ]);
    const { stdout } = await this.dockerApiCall((abortSignal) =>
      readContainerLogs(container, abortSignal),
    );
    if (result.StatusCode !== 0) {
      throw new AppError("CLONE_FAILED", "No se pudo clonar el repositorio.", 502, {
        exitCode: result.StatusCode,
      });
    }

    const lastLine = stdout
      .toString("utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .at(-1);
    try {
      return cloneResultSchema.parse(JSON.parse(lastLine ?? ""));
    } catch {
      throw new AppError("CLONE_FAILED", "El contenedor de clonacion devolvio datos invalidos.", 502);
    }
  }

  private dockerApiCall<T>(operation: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
    return withAbortDeadline(
      operation,
      this.config.DOCKER_API_TIMEOUT_MS,
      new AppError("DOCKER_API_TIMEOUT", "Docker no respondio a tiempo.", 503),
    );
  }

  private async bestEffortRemoveContainer(name: string, retryDelays: number[]): Promise<void> {
    for (const delayMs of retryDelays) {
      if (delayMs > 0) await delay(delayMs);
      try {
        await this.dockerApiCall((abortSignal) =>
          this.client.getContainer(name).remove({ force: true, v: false, abortSignal }),
        );
        return;
      } catch {
        // The resource may not be visible yet; retry only after creation timeouts.
      }
    }
  }

  private async bestEffortRemoveVolume(name: string, retryDelays: number[]): Promise<void> {
    for (const delayMs of retryDelays) {
      if (delayMs > 0) await delay(delayMs);
      try {
        await this.dockerApiCall((abortSignal) =>
          this.client.getVolume(name).remove({ force: true, abortSignal }),
        );
        return;
      } catch {
        // The resource may not be visible yet; retry only after creation timeouts.
      }
    }
  }
}

function bufferSink(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
}

async function readContainerLogs(
  container: CloneContainer,
  abortSignal: AbortSignal,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const multiplexed = await container.logs({
    stdout: true,
    stderr: true,
    timestamps: false,
    abortSignal,
  });
  const stream = Readable.from([multiplexed]);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const ended = waitForStreamEnd(stream);
  container.modem.demuxStream(stream, bufferSink(stdout), bufferSink(stderr));
  await ended;
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

function waitForStreamEnd(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", reject);
  });
}

async function withAbortDeadline<T>(
  operation: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutError: AppError,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertDockerNamePart(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) {
    throw new AppError("INVALID_RUN_ID", "El identificador del run no es valido.");
  }
}

function dockerStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function cleanupError(failures: string[], operationError?: unknown): AppError {
  return appErrorWithCause(
    "WORKSPACE_CLEANUP_FAILED",
    "No se pudieron eliminar todos los recursos temporales del workspace.",
    500,
    operationError,
    {
      failures,
      operationCode: operationError instanceof AppError ? operationError.code : undefined,
    },
  );
}

function cleanupRetryDelays(error: unknown): number[] {
  return error instanceof AppError && error.code === "DOCKER_API_TIMEOUT"
    ? [0, 100, 500, 1_000]
    : [0];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appErrorWithCause(
  code: string,
  message: string,
  statusCode: number,
  cause: unknown,
  details?: unknown,
): AppError {
  const error = new AppError(code, message, statusCode, details);
  Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  return error;
}
