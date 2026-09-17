import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { Duplex } from "node:stream";

import { loadConfig } from "../config.ts";
import { AppError } from "../errors.ts";
import {
  type CloneGithubClient,
  type ClonedWorkspace,
  DockerWorkspaceRuntime,
  type RepositoryCloneInput,
  RepositoryWorkspaceService,
  type WorkspaceDockerClient,
  type WorkspaceRuntime,
} from "./repository-workspace.ts";

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const config = loadConfig({
  NODE_ENV: "test",
  MASTER_KEY: randomBytes(32).toString("base64"),
  SESSION_SECRET: randomBytes(32).toString("base64"),
  GITHUB_OAUTH_CLIENT_ID: "github-client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "manteiner-test",
  GITHUB_APP_CLIENT_ID: "github-app-client-id",
  GITHUB_APP_CLIENT_SECRET: "github-app-client-secret",
  GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString("base64"),
  MAX_REPO_SIZE_KB: "1000",
} as NodeJS.ProcessEnv);

const input: RepositoryCloneInput = {
  runId: "run-123",
  installationId: 777,
  githubRepositoryId: 999,
};

class FakeGithub implements CloneGithubClient {
  readonly calls: string[] = [];
  revokeError?: Error;

  constructor(readonly sizeKb = 500) {}

  async createCloneToken(installationId: number, repositoryId: number): Promise<string> {
    this.calls.push(`token:${installationId}:${repositoryId}`);
    return "clone-token";
  }

  async getRepositoryForClone(token: string, repositoryId: number) {
    this.calls.push(`size:${token}:${repositoryId}`);
    return {
      id: repositoryId,
      owner: { login: "trusted-owner" },
      name: "trusted-repository",
      default_branch: "main",
      size: this.sizeKb,
    };
  }

  async revokeInstallationToken(token: string): Promise<void> {
    this.calls.push(`revoke:${token}`);
    if (this.revokeError) throw this.revokeError;
  }
}

class FakeRuntime implements WorkspaceRuntime {
  readonly calls: string[] = [];
  cloneError?: Error;
  removeError?: Error;

  async createVolume(runId: string): Promise<string> {
    this.calls.push(`create:${runId}`);
    return `manteiner-ws-${runId}`;
  }

  async cloneRepository(
    clone: Parameters<WorkspaceRuntime["cloneRepository"]>[0],
  ): Promise<Omit<ClonedWorkspace, "volumeName">> {
    this.calls.push(
      `clone:${clone.volumeName}:${clone.owner}/${clone.repository}:${clone.branch}:${clone.token}`,
    );
    if (this.cloneError) throw this.cloneError;
    return { baseSha: "a".repeat(40), sizeKb: 321 };
  }

  async removeVolume(volumeName: string): Promise<void> {
    this.calls.push(`remove:${volumeName}`);
    if (this.removeError) throw this.removeError;
  }
}

describe("RepositoryWorkspaceService", () => {
  it("valida el tamaño, clona, expone el volumen y lo elimina al terminar", async () => {
    const github = new FakeGithub();
    const runtime = new FakeRuntime();
    const service = new RepositoryWorkspaceService(config, github, runtime);

    const result = await service.withClonedRepository(input, async (workspace) => {
      runtime.calls.push(`use:${workspace.volumeName}`);
      assert.deepEqual(workspace, {
        volumeName: "manteiner-ws-run-123",
        baseSha: "a".repeat(40),
        sizeKb: 321,
      });
      return "used";
    });

    assert.equal(result, "used");
    assert.deepEqual(github.calls, [
      "token:777:999",
      "size:clone-token:999",
      "revoke:clone-token",
    ]);
    assert.deepEqual(runtime.calls, [
      "create:run-123",
      "clone:manteiner-ws-run-123:trusted-owner/trusted-repository:main:clone-token",
      "use:manteiner-ws-run-123",
      "remove:manteiner-ws-run-123",
    ]);
  });

  it("rechaza un repositorio grande antes de crear el volumen", async () => {
    const runtime = new FakeRuntime();
    const service = new RepositoryWorkspaceService(config, new FakeGithub(1_001), runtime);

    await assert.rejects(
      () => service.withClonedRepository(input, async () => undefined),
      (error: unknown) => error instanceof AppError && error.code === "WORKSPACE_TOO_LARGE",
    );
    assert.deepEqual(runtime.calls, []);
  });

  it("elimina el volumen si falla el clon o el consumidor", async () => {
    const cloneRuntime = new FakeRuntime();
    cloneRuntime.cloneError = new Error("clone failed");
    const cloneService = new RepositoryWorkspaceService(config, new FakeGithub(), cloneRuntime);
    await assert.rejects(() => cloneService.withClonedRepository(input, async () => undefined));
    assert.deepEqual(cloneRuntime.calls, [
      "create:run-123",
      "clone:manteiner-ws-run-123:trusted-owner/trusted-repository:main:clone-token",
      "remove:manteiner-ws-run-123",
    ]);

    const consumerRuntime = new FakeRuntime();
    const consumerService = new RepositoryWorkspaceService(config, new FakeGithub(), consumerRuntime);
    await assert.rejects(
      () =>
        consumerService.withClonedRepository(input, async () => {
          throw new Error("agent failed");
        }),
      /agent failed/,
    );
    assert.equal(consumerRuntime.calls.at(-1), "remove:manteiner-ws-run-123");
  });

  it("intenta todas las limpiezas y reporta cuáles fallaron", async () => {
    const github = new FakeGithub();
    github.revokeError = new Error("revoke failed");
    const runtime = new FakeRuntime();
    runtime.cloneError = new Error("clone failed");
    runtime.removeError = new Error("remove failed");
    const service = new RepositoryWorkspaceService(config, github, runtime);

    await assert.rejects(
      () => service.withClonedRepository(input, async () => undefined),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "WORKSPACE_CLEANUP_FAILED");
        assert.deepEqual(error.details, {
          failures: ["volume", "github_token"],
          operationCode: undefined,
        });
        return true;
      },
    );
    assert.equal(runtime.calls.at(-1), "remove:manteiner-ws-run-123");
    assert.equal(github.calls.at(-1), "revoke:clone-token");
  });
});

class AttachedInput extends Duplex {
  input = "";

  override _read(): void {}

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.input += chunk.toString();
    callback();
  }
}

function fakeDocker(
  options: {
    wait?: Promise<{ StatusCode: number }>;
    createVolume?: Promise<{ Name: string }>;
    createError?: unknown;
    streamErrorOnStart?: Error;
  } = {},
) {
  const stream = new AttachedInput();
  const calls: string[] = [];
  let createOptions: Parameters<WorkspaceDockerClient["createContainer"]>[0] | undefined;
  const output = Buffer.from(
    `${JSON.stringify({ baseSha: "b".repeat(40), sizeKb: 456 })}\n`,
  );
  const container = {
    modem: {
      demuxStream(source: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) {
        source.on("data", (chunk) => stdout.write(chunk));
      },
    },
    async attach() {
      calls.push("attach");
      return stream;
    },
    async start() {
      calls.push("start");
      if (options.streamErrorOnStart) {
        stream.emit("error", options.streamErrorOnStart);
        return await new Promise(() => undefined);
      }
    },
    async wait() {
      calls.push("wait");
      return await (options.wait ?? Promise.resolve({ StatusCode: 0 }));
    },
    async logs() {
      calls.push("logs");
      return output;
    },
    async remove() {
      calls.push("remove-container");
    },
  };
  const client: WorkspaceDockerClient = {
    async createVolume(volumeOptions) {
      calls.push(`create-volume:${volumeOptions.Name}`);
      return await (options.createVolume ??
        Promise.resolve({ Name: String(volumeOptions.Name) }));
    },
    getVolume(name) {
      return {
        async remove() {
          calls.push(`remove-volume:${name}`);
        },
      };
    },
    getContainer() {
      return container;
    },
    async createContainer(value) {
      calls.push("create-container");
      createOptions = value;
      if (options.createError) throw options.createError;
      return container;
    },
  };
  return { client, stream, calls, get createOptions() { return createOptions; } };
}

describe("DockerWorkspaceRuntime", () => {
  it("crea el contenedor endurecido, envia el token y elimina sus recursos", async () => {
    const docker = fakeDocker();
    const runtime = new DockerWorkspaceRuntime(config, docker.client);
    const volumeName = await runtime.createVolume("run-123");
    const result = await runtime.cloneRepository({
      runId: "run-123",
      volumeName,
      owner: "octocat",
      repository: "hello-world",
      branch: "main",
      token: "clone-token",
    });
    await runtime.removeVolume(volumeName);

    assert.deepEqual(result, { baseSha: "b".repeat(40), sizeKb: 456 });
    assert.equal(docker.stream.input, "clone-token\n");
    assert.deepEqual(docker.createOptions?.Cmd, [
      "/usr/local/bin/clone.sh",
      "octocat",
      "hello-world",
      "main",
    ]);
    assert.deepEqual(docker.createOptions?.HostConfig?.CapDrop, ["ALL"]);
    assert.equal(docker.createOptions?.HostConfig?.ReadonlyRootfs, true);
    assert.deepEqual(docker.calls, [
      "create-volume:manteiner-ws-run-123",
      "create-container",
      "attach",
      "start",
      "wait",
      "logs",
      "remove-container",
      "remove-volume:manteiner-ws-run-123",
    ]);
  });

  it("clasifica una imagen ausente y un timeout, eliminando el contenedor", async () => {
    const missing = fakeDocker({ createError: { statusCode: 404 } });
    await assert.rejects(
      () =>
        new DockerWorkspaceRuntime(config, missing.client).cloneRepository({
          runId: "run-missing",
          volumeName: "volume",
          owner: "octocat",
          repository: "hello-world",
          branch: "main",
          token: "token",
        }),
      (error: unknown) => error instanceof AppError && error.code === "IMAGE_MISSING",
    );

    const timedOut = fakeDocker({ wait: new Promise(() => undefined) });
    await assert.rejects(
      () =>
        new DockerWorkspaceRuntime(
          { ...config, CLONE_TIMEOUT_MS: 10 },
          timedOut.client,
        ).cloneRepository({
          runId: "run-timeout",
          volumeName: "volume",
          owner: "octocat",
          repository: "hello-world",
          branch: "main",
          token: "token",
        }),
      (error: unknown) => error instanceof AppError && error.code === "CLONE_TIMEOUT",
    );
    assert.equal(timedOut.calls.at(-1), "remove-container");

    const createTimedOut = fakeDocker({ createVolume: new Promise(() => undefined) });
    await assert.rejects(
      () =>
        new DockerWorkspaceRuntime(
          { ...config, DOCKER_API_TIMEOUT_MS: 10 },
          createTimedOut.client,
        ).createVolume("run-volume-timeout"),
      (error: unknown) => error instanceof AppError && error.code === "DOCKER_API_TIMEOUT",
    );
    assert.equal(createTimedOut.calls.at(-1), "remove-volume:manteiner-ws-run-volume-timeout");
  });

  it("observa errores del socket aunque container.start siga pendiente", async () => {
    const failed = fakeDocker({ streamErrorOnStart: new Error("socket failed") });
    await assert.rejects(
      () =>
        new DockerWorkspaceRuntime(config, failed.client).cloneRepository({
          runId: "run-stream-error",
          volumeName: "volume",
          owner: "octocat",
          repository: "hello-world",
          branch: "main",
          token: "token",
        }),
      (error: unknown) => error instanceof AppError && error.code === "CLONE_FAILED",
    );
    assert.equal(failed.calls.at(-1), "remove-container");
  });
});
