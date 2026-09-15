/**
 * Informe de ejemplo valido. Lo usan los tests y sirve como referencia legible de
 * como tiene que verse la salida del agente.
 */

import { STEP_KEYS, STEP_TITLES, type MaintenanceReport } from "./maintenance-report.ts";

export function validReport(overrides: Partial<MaintenanceReport> = {}): MaintenanceReport {
  return {
    schema_version: "1.0",
    audit_type: "maintenance",
    summary: {
      health_score: 72,
      headline: "Dependencias casi al dia, runtime de Lambda proximo a fin de soporte",
      overview:
        "El repositorio esta razonablemente mantenido. Las dependencias directas estan\n" +
        "cerca de sus ultimas versiones y el tooling es moderno.\n\n" +
        "El punto mas urgente no son las dependencias sino el runtime: las funciones\n" +
        "declaran `nodejs18.x`, que tiene fecha de fin de soporte.",
    },
    stack_detected: [
      { name: "Node.js", version: "18", category: "runtime", evidence: "serverless.yml" },
      { name: "TypeScript", version: "5.6.2", category: "language", evidence: "package.json" },
      { name: "pnpm", version: "9", category: "package-manager", evidence: "pnpm-lock.yaml" },
    ],
    steps: STEP_KEYS.map((key) => ({
      key,
      title: STEP_TITLES[key],
      status: "completed" as const,
      description: `Se completo la fase ${key} sin incidentes.`,
    })),
    dependency_updates: {
      applied: [
        {
          name: "zod",
          from: "3.22.4",
          to: "3.23.8",
          bump: "minor",
          scope: "prod",
          changelog_url: "https://github.com/colinhacks/zod/releases",
          rationale: "Solo correcciones y nuevas utilidades; sin cambios incompatibles.",
        },
      ],
      deferred: [
        {
          name: "next",
          from: "15.3.0",
          to: "16.0.1",
          bump: "major",
          reason: "Cambio de major con breaking changes en el router.",
          breaking_changes: ["Se elimino el App Router experimental"],
          migration_guide_url: "https://nextjs.org/docs/upgrading",
          estimated_effort: "high",
        },
      ],
      unmaintained: [],
    },
    findings: [
      {
        finding_key: "runtime-eol:node:18",
        category: "runtime-eol",
        severity: "high",
        effort: "medium",
        confidence: "high",
        title: "Las funciones Lambda usan Node 18, proximo a fin de soporte",
        description: "Tres funciones declaran `runtime: nodejs18.x` en `serverless.yml`.",
        recommendation: "Migrar a `nodejs20.x` o superior y validar en un entorno de staging.",
        locations: [{ path: "serverless.yml", line: 12 }],
        references: [
          {
            title: "AWS Lambda runtime support policy",
            url: "https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html",
            official: true,
          },
        ],
      },
    ],
    proposed_pull_request: {
      title: "chore(deps): actualizaciones seguras de dependencias",
      body: "Actualiza `zod` de 3.22.4 a 3.23.8.\n\nNo incluye majors con breaking changes.",
      files_changed: ["package.json", "pnpm-lock.yaml"],
    },
    out_of_scope_notes: [
      {
        area: "security",
        note: "Se observo una dependencia con CVE conocido. Corresponde a la auditoria de seguridad.",
      },
    ],
    limitations: ["No se pudo ejecutar la suite de tests: requiere credenciales de base de datos."],
    ...overrides,
  };
}
