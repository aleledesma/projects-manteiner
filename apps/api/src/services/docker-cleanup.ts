/**
 * Limpieza de huerfanos al arrancar la API.
 *
 * Si el proceso murio a mitad de un run, quedaron tres cosas inconsistentes:
 * filas en `runs` que dicen estar corriendo y no lo estan, contenedores vivos y
 * volumenes con el repositorio clonado adentro. Lo tercero es lo grave: el
 * disenio entero se apoya en que el repo no sobreviva al run (doc 05).
 *
 * Es best-effort a proposito: la API tiene que arrancar igual aunque Docker no
 * este disponible. Lo que no puede es arrancar en silencio, asi que informa.
 */

import Dockerode from "dockerode";

import type { Config } from "../config.ts";
import type { DatabaseConnection } from "../db/client.ts";
import { MANTEINER_LABEL, WORKSPACE_VOLUME_PREFIX } from "./docker-helpers.ts";

export interface CleanupDockerClient {
  listContainers(options: {
    all: boolean;
    filters: Record<string, string[]>;
  }): Promise<{ Id: string }[]>;
  getContainer(id: string): { remove(options: { force: boolean; v: boolean }): Promise<unknown> };
  listVolumes(): Promise<{ Volumes?: { Name: string }[] | null }>;
  getVolume(name: string): { remove(options: { force: boolean }): Promise<unknown> };
}

export interface CleanupReport {
  readonly runs: number;
  readonly containers: number;
  readonly volumes: number;
  readonly failures: string[];
}

/** Estados que solo pueden existir mientras el proceso que los creo sigue vivo. */
const ESTADOS_VIVOS = ["preparing", "cloning", "running"] as const;

export class OrphanCleanupService {
  readonly #docker: CleanupDockerClient;

  constructor(
    private readonly database: DatabaseConnection,
    config: Config,
    client?: CleanupDockerClient,
    private readonly now: () => number = Date.now,
  ) {
    this.#docker = client ?? (new Dockerode({
      ...(config.DOCKER_SOCKET ? { socketPath: config.DOCKER_SOCKET } : {}),
    }) as unknown as CleanupDockerClient);
  }

  async run(): Promise<CleanupReport> {
    const failures: string[] = [];
    const runs = this.#marcarRunsHuerfanos();

    let containers = 0;
    try {
      // Por etiqueta y no por nombre: un contenedor renombrado a mano seguiria
      // siendo nuestro, y los nombres no son un inventario confiable.
      const encontrados = await this.#docker.listContainers({
        all: true,
        filters: { label: [MANTEINER_LABEL] },
      });
      for (const contenedor of encontrados) {
        try {
          await this.#docker.getContainer(contenedor.Id).remove({ force: true, v: true });
          containers += 1;
        } catch {
          failures.push(`container:${contenedor.Id.slice(0, 12)}`);
        }
      }
    } catch {
      failures.push("containers");
    }

    let volumes = 0;
    try {
      const listado = await this.#docker.listVolumes();
      for (const volumen of listado.Volumes ?? []) {
        if (!volumen.Name.startsWith(WORKSPACE_VOLUME_PREFIX)) continue;
        try {
          await this.#docker.getVolume(volumen.Name).remove({ force: true });
          volumes += 1;
        } catch {
          failures.push(`volume:${volumen.Name}`);
        }
      }
    } catch {
      failures.push("volumes");
    }

    return { runs, containers, volumes, failures };
  }

  /**
   * Un run que quedo en un estado vivo no puede retomarse: su contenedor y su
   * volumen ya no existen. Se cierra como fallido para que no quede girando en
   * la UI para siempre.
   */
  #marcarRunsHuerfanos(): number {
    const ahora = this.now();
    const marcadores = ESTADOS_VIVOS.map(() => "?").join(", ");
    const resultado = this.database.sqlite
      .prepare(
        `UPDATE runs
         SET status = 'failed', error_code = 'SERVER_RESTART',
             error_message = 'La API se reinicio mientras el run estaba en curso.',
             finished_at = ?,
             duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE ? - started_at END
         WHERE status IN (${marcadores})`,
      )
      .run(ahora, ahora, ...ESTADOS_VIVOS);
    return resultado.changes;
  }
}
