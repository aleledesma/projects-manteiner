/**
 * Prompts versionados del agente.
 *
 * La version se guarda en `runs.agent_version` (doc 02). Cambiar el prompt sin
 * cambiar la version rompe la comparabilidad del historico: dos runs con el mismo
 * `agent_version` tienen que haber recibido las mismas instrucciones.
 */

import { readFileSync } from "node:fs";

export const AGENT_VERSION = "maintenance@1" as const;

export interface PromptContext {
  owner: string;
  repo: string;
  branch: string;
  sha: string;
  /** Directorio de trabajo dentro del contenedor. */
  workdir?: string;
}

const PLANTILLA = readFileSync(
  new URL("./prompts/maintenance.v1.md", import.meta.url),
  "utf8",
);

/**
 * Interpola el contexto del run en la plantilla.
 *
 * Falla si queda algun `{{placeholder}}` sin reemplazar. Un prompt enviado con un
 * hueco literal produce una auditoria silenciosamente peor, y nadie se entera
 * hasta leer el informe.
 */
export function buildMaintenancePrompt(ctx: PromptContext): string {
  const valores: Record<string, string> = {
    owner: ctx.owner,
    repo: ctx.repo,
    branch: ctx.branch,
    sha: ctx.sha,
    workdir: ctx.workdir ?? "/work/repo",
  };

  const texto = PLANTILLA.replace(/\{\{(\w+)\}\}/g, (original, clave: string) => {
    const valor = valores[clave];
    return valor ?? original;
  });

  const faltantes = [...texto.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  if (faltantes.length > 0) {
    throw new Error(
      `El prompt ${AGENT_VERSION} quedo con placeholders sin resolver: ${[...new Set(faltantes)].join(", ")}`,
    );
  }

  return texto;
}

/** La plantilla cruda, sin interpolar. Util para tests y para mostrarla en la UI. */
export function maintenancePromptTemplate(): string {
  return PLANTILLA;
}
