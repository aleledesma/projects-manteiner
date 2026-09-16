import Dockerode from "dockerode";

import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";

export interface DockerClient {
  ping(): Promise<unknown>;
  version(): Promise<Dockerode.DockerVersion>;
}

export interface DockerStatus {
  available: boolean;
  version?: string;
  apiVersion?: string;
  os?: string;
  architecture?: string;
}

export class DockerService {
  private readonly client: DockerClient;
  private readonly timeoutMs: number;

  constructor(config: Config, client?: DockerClient) {
    this.timeoutMs = config.DOCKER_API_TIMEOUT_MS;
    this.client =
      client ??
      new Dockerode({
        ...(config.DOCKER_SOCKET ? { socketPath: config.DOCKER_SOCKET } : {}),
        timeout: config.DOCKER_API_TIMEOUT_MS,
      });
  }

  async status(): Promise<DockerStatus> {
    try {
      const version = await this.withDeadline(
        Promise.all([this.client.ping(), this.client.version()]).then(([, value]) => value),
      );
      return {
        available: true,
        version: version.Version,
        apiVersion: version.ApiVersion,
        os: version.Os,
        architecture: version.Arch,
      };
    } catch {
      return { available: false };
    }
  }

  private async withDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Docker API timeout")), this.timeoutMs);
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async requireAvailable(): Promise<DockerStatus> {
    const status = await this.status();
    if (!status.available) {
      throw new AppError(
        "DOCKER_UNAVAILABLE",
        "Docker no esta disponible. Inicia Docker Desktop e intenta nuevamente.",
        503,
      );
    }
    return status;
  }
}
