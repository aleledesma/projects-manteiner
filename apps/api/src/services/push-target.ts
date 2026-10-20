import { AppError } from "../errors.ts";

/**
 * Archivos que pueden entrar al commit del PR. Son pathspecs fijos de la app:
 * nunca salen del agente ni del repositorio. Lo demas que haya tocado el agente
 * queda fuera del commit y se informa como descartado (doc 03).
 */
export const PUBLISH_ALLOWLIST: readonly string[] = [
  ":(glob)**/package.json",
  ":(glob)**/package-lock.json",
  ":(glob)**/npm-shrinkwrap.json",
  ":(glob)**/pnpm-lock.yaml",
  ":(glob)**/pnpm-workspace.yaml",
  ":(glob)**/yarn.lock",
  ":(glob)**/bun.lock",
  ":(glob)**/bun.lockb",
  ":(glob)**/requirements.txt",
  ":(glob)**/pyproject.toml",
  ":(glob)**/poetry.lock",
  ":(glob)**/go.mod",
  ":(glob)**/go.sum",
  ":(glob)**/Cargo.toml",
  ":(glob)**/Cargo.lock",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/.opencode/**",
];

/**
 * El nombre de la rama nunca es un dato de entrada: se computa de valores que
 * genera la app (doc 03, primera barrera).
 */
export function pushBranchFor(auditType: string, runId: string): string {
  return `manteiner/${auditType}/${runId.slice(0, 8)}`;
}

/**
 * Aserción dura antes de cualquier push (doc 03, tercera barrera). GitHub no
 * impide pushear a la rama por defecto con `contents: write`: lo impide esto.
 */
export function assertPushTarget(branch: string, defaultBranch: string): void {
  if (
    !/^manteiner\/[a-z]+\/[0-9a-f]{8}$/.test(branch) ||
    branch === defaultBranch ||
    `refs/heads/${branch}` === defaultBranch
  ) {
    throw new AppError(
      "INVALID_PUSH_TARGET",
      "Se intento publicar en una rama no permitida.",
      500,
      { branch },
    );
  }
}
