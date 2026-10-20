/**
 * Publicacion del PR (Fase 7, doc 03).
 *
 * El push lo hace el contenedor de publicacion; aca solo se pide el token, se
 * decide si corresponde publicar y se hace el `POST /pulls`, que es una llamada
 * HTTP y no necesita el repositorio.
 */

import { AppError } from "../errors.ts";
import type { GithubPublishRepository, GithubPullRequest } from "./github-app.ts";
import { assertPushTarget, pushBranchFor } from "./push-target.ts";
import type { PublishRuntime } from "./repository-workspace.ts";

export interface PublishGithubClient {
  createPublishToken(installationId: number, repositoryId: number): Promise<string>;
  getRepositoryForPublish(token: string, repositoryId: number): Promise<GithubPublishRepository>;
  createPullRequest(
    token: string,
    input: { owner: string; repository: string; title: string; body: string; head: string; base: string },
  ): Promise<GithubPullRequest>;
  revokeInstallationToken(token: string): Promise<void>;
}

export interface PublishPullRequestInput {
  runId: string;
  auditType: string;
  installationId: number;
  githubRepositoryId: number;
  volumeName: string;
  baseSha: string;
  title: string;
  body: string;
  /** Archivos que el agente modifico segun el diff, para informar los descartados. */
  touchedFiles: readonly string[];
}

/**
 * Lo que queda registrado en el informe. `skipped` y `failed` no invalidan la
 * auditoria: el informe vale igual y la UI explica por que no hubo PR.
 */
export type PullRequestOutcome =
  | {
      status: "created";
      number: number;
      url: string;
      branch: string;
      commitSha: string;
      files: string[];
      discarded: string[];
    }
  | { status: "skipped"; code: string; message: string; discarded: string[] }
  | { status: "failed"; code: string; message: string; branch: string | null };

export class PullRequestService {
  constructor(
    private readonly github: PublishGithubClient,
    private readonly runtime: PublishRuntime,
  ) {}

  async publish(input: PublishPullRequestInput): Promise<PullRequestOutcome> {
    const branch = pushBranchFor(input.auditType, input.runId);
    const token = await this.github.createPublishToken(input.installationId, input.githubRepositoryId);
    let pushed = false;

    try {
      const repository = await this.github.getRepositoryForPublish(token, input.githubRepositoryId);
      if (repository.archived) {
        return {
          status: "skipped",
          code: "REPO_ARCHIVED",
          message: "El repositorio esta archivado: la auditoria vale, pero no se puede abrir un PR.",
          discarded: [],
        };
      }
      // La rama por defecto se lee fresca de GitHub, no de la base: si cambio
      // desde que se vinculo el repo, la asercion igual tiene que cubrirla.
      assertPushTarget(branch, repository.default_branch);

      const resultado = await this.runtime.publishBranch({
        runId: input.runId,
        owner: repository.owner.login,
        repository: repository.name,
        baseSha: input.baseSha,
        headBranch: branch,
        defaultBranch: repository.default_branch,
        volumeName: input.volumeName,
        token,
        commitMessage: commitMessage(input.title, input.runId),
      });

      if (resultado.status === "no-changes") {
        return {
          status: "skipped",
          code: "NO_ALLOWED_CHANGES",
          message: "El agente no dejo cambios en manifiestos ni lockfiles; no hay nada que proponer.",
          discarded: [...input.touchedFiles],
        };
      }
      pushed = true;

      const discarded = input.touchedFiles.filter((file) => !resultado.files.includes(file));
      const pr = await this.github.createPullRequest(token, {
        owner: repository.owner.login,
        repository: repository.name,
        title: singleLine(input.title, 100),
        body: pullRequestBody(input.body, input.runId, discarded),
        head: branch,
        base: repository.default_branch,
      });
      return {
        status: "created",
        number: pr.number,
        url: pr.html_url,
        branch,
        commitSha: resultado.commitSha,
        files: resultado.files,
        discarded,
      };
    } catch (error) {
      // La asercion no se degrada a "sin PR": si salta, hay un bug en la app.
      if (error instanceof AppError && error.code === "INVALID_PUSH_TARGET") throw error;
      return {
        status: "failed",
        code: error instanceof AppError ? error.code : "PUBLISH_FAILED",
        message: error instanceof AppError ? error.message : "No se pudo publicar el PR.",
        // Si el push salio y fallo el POST /pulls, la rama quedo en GitHub y el
        // usuario puede abrir el PR a mano.
        branch: pushed ? branch : null,
      };
    } finally {
      await this.github.revokeInstallationToken(token).catch(() => {});
    }
  }
}

/** Archivos que toca un diff unificado de git (`diff --git a/x b/x`). */
export function filesInDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    files.add(match[2]!);
  }
  return [...files];
}

function commitMessage(title: string, runId: string): string {
  return `${singleLine(title, 72)}\n\nGenerado por Manteiner (run ${runId.slice(0, 8)}).`;
}

function singleLine(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, " ").trim() || "Actualizaciones de mantenimiento";
  return limpio.length > max ? `${limpio.slice(0, max - 1)}…` : limpio;
}

function pullRequestBody(body: string, runId: string, discarded: readonly string[]): string {
  const partes = [body.trim(), "---"];
  if (discarded.length > 0) {
    partes.push(
      "**Cambios descartados.** El agente modifico archivos fuera de la lista permitida " +
        "(manifiestos y lockfiles) y no se incluyeron en este PR:\n\n" +
        discarded.map((file) => `- \`${file}\``).join("\n"),
    );
  }
  partes.push(
    `🤖 Generado por **Manteiner** a partir de una auditoria hecha por un agente de IA ` +
      `(run \`${runId.slice(0, 8)}\`). Revisa los cambios antes de hacer merge.`,
  );
  return partes.join("\n\n");
}
