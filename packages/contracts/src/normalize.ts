/**
 * Validaciones y normalizaciones que van MAS ALLA de la forma del JSON.
 *
 * El JSON Schema garantiza la forma; esto garantiza el sentido. Doc 06.
 *
 * Todo lo de aca es deliberadamente NO destructivo: nunca se rechaza un informe
 * entero por una incoherencia menor. Se corrige lo corregible, se anota lo raro
 * en `warnings`, y el run sigue. Perder una auditoria completa porque una URL
 * era http en vez de https seria absurdo.
 *
 * Las verificaciones que necesitan el workspace (que `locations[].path` exista
 * de verdad, que `files_changed` coincida con el diff real) NO viven aca: se
 * hacen en el orquestador, que es quien tiene acceso al repositorio. Fase 5.
 */

import type { MaintenanceReport } from "./maintenance-report.ts";

export interface Warning {
  code: string;
  message: string;
}

export interface NormalizeResult {
  report: MaintenanceReport;
  warnings: Warning[];
}

export function normalizeReport(input: MaintenanceReport): NormalizeResult {
  const warnings: Warning[] = [];
  const report: MaintenanceReport = structuredClone(input);

  dedupeFindingKeys(report, warnings);
  dropInsecureReferences(report, warnings);
  downgradeUnsupportedSeverities(report, warnings);
  checkSkipReasons(report, warnings);
  checkDiffCoherence(report, warnings);

  return { report, warnings };
}

/**
 * `finding_key` debe ser unico dentro del run: es la clave con la que despues
 * comparamos auditorias entre si. Un duplicado arruinaria esa comparacion, asi
 * que se desambigua con un sufijo en vez de descartar el hallazgo.
 */
function dedupeFindingKeys(report: MaintenanceReport, warnings: Warning[]): void {
  const vistos = new Set<string>();

  for (const finding of report.findings) {
    if (!vistos.has(finding.finding_key)) {
      vistos.add(finding.finding_key);
      continue;
    }

    const original = finding.finding_key;
    let n = 2;
    while (vistos.has(`${original}-${n}`)) n++;
    finding.finding_key = `${original}-${n}`;
    vistos.add(finding.finding_key);

    warnings.push({
      code: "DUPLICATE_FINDING_KEY",
      message: `finding_key duplicado "${original}", renombrado a "${finding.finding_key}".`,
    });
  }
}

/**
 * Las referencias son el respaldo de las afirmaciones del agente. Una URL que no
 * es https no sirve como respaldo verificable, y ademas seria un enlace inseguro
 * en el informe y en el PDF.
 */
function dropInsecureReferences(report: MaintenanceReport, warnings: Warning[]): void {
  for (const finding of report.findings) {
    if (!finding.references?.length) continue;

    const validas = finding.references.filter((ref) => {
      try {
        return new URL(ref.url).protocol === "https:";
      } catch {
        return false;
      }
    });

    const descartadas = finding.references.length - validas.length;
    if (descartadas > 0) {
      warnings.push({
        code: "INSECURE_REFERENCE_DROPPED",
        message: `Se descartaron ${descartadas} referencia(s) no-https en "${finding.finding_key}".`,
      });
      finding.references = validas;
    }
  }
}

/**
 * Un hallazgo `high` con `confidence: low` es una alarma sin sustento. Se baja a
 * `medium`: sigue visible, pero no encabeza el informe ni asusta al usuario con
 * algo que el propio agente no pudo verificar.
 */
function downgradeUnsupportedSeverities(report: MaintenanceReport, warnings: Warning[]): void {
  for (const finding of report.findings) {
    if (finding.severity === "high" && finding.confidence === "low") {
      finding.severity = "medium";
      warnings.push({
        code: "SEVERITY_DOWNGRADED",
        message: `"${finding.finding_key}": severity high con confidence low, degradado a medium.`,
      });
    }
  }
}

/** Un paso salteado sin motivo no le dice nada al usuario. */
function checkSkipReasons(report: MaintenanceReport, warnings: Warning[]): void {
  for (const step of report.steps) {
    if (step.status === "skipped" && !step.skip_reason?.trim()) {
      warnings.push({
        code: "MISSING_SKIP_REASON",
        message: `El paso "${step.key}" figura como skipped pero no explica por que.`,
      });
    }
  }
}

/**
 * Si el agente dice haber aplicado actualizaciones, deberia haber propuesto un PR
 * (y al reves). No es fatal: el diff real manda, y el orquestador lo compara en
 * la Fase 5. Aca solo dejamos registro de la incoherencia.
 */
function checkDiffCoherence(report: MaintenanceReport, warnings: Warning[]): void {
  const aplicadas = report.dependency_updates.applied.length;
  const hayPr = report.proposed_pull_request !== null;

  if (aplicadas > 0 && !hayPr) {
    warnings.push({
      code: "APPLIED_WITHOUT_PR",
      message: `Declara ${aplicadas} actualizacion(es) aplicada(s) pero no propone PR.`,
    });
  }

  if (aplicadas === 0 && hayPr) {
    warnings.push({
      code: "PR_WITHOUT_APPLIED",
      message: "Propone un PR pero no declara ninguna actualizacion aplicada.",
    });
  }
}
