/**
 * Contrato de salida del agente de mantenimiento.
 *
 * Fuente de verdad UNICA: de este esquema Zod se derivan
 *   - el JSON Schema que restringe al modelo (structured output), y
 *   - la validacion en el host.
 * Asi no se pueden desincronizar. Ver doc 06.
 *
 * Este modulo es deliberadamente PURO: sin transformaciones ni `.default()`.
 * `z.toJSONSchema()` emite el tipo de SALIDA, asi que cualquier transform aca
 * haria que el JSON Schema publicado difiera de lo que se le pide al modelo.
 * Las normalizaciones viven en `normalize.ts`.
 */

import { z } from "zod";

export const SCHEMA_VERSION = "1.0" as const;

// ─── Enumeraciones ──────────────────────────────────────────────────────────

/** Las 7 fases fijas del agente. El orden importa: es el orden de ejecucion. */
export const STEP_KEYS = [
  "repo-discovery",
  "dependency-inventory",
  "dependency-research",
  "safe-updates",
  "runtime-analysis",
  "maintainability-review",
  "report-assembly",
] as const;

export type StepKey = (typeof STEP_KEYS)[number];

/** Titulo literal que el agente debe usar en su lista de tareas. Ver doc 07. */
export const STEP_TITLES: Record<StepKey, string> = {
  "repo-discovery": "Reconocimiento del repositorio",
  "dependency-inventory": "Inventario de dependencias",
  "dependency-research": "Investigacion de dependencias",
  "safe-updates": "Aplicacion de actualizaciones seguras",
  "runtime-analysis": "Analisis de runtime y entorno",
  "maintainability-review": "Revision de mantenibilidad",
  "report-assembly": "Elaboracion del informe",
};

export const FINDING_CATEGORIES = [
  "runtime-eol",
  "dependency",
  "code-quality",
  "duplication",
  "build",
  "ci-cd",
  "tooling",
  "documentation",
  "testing",
  "configuration",
  "performance",
  "dx",
] as const;

export const SEVERITIES = ["info", "low", "medium", "high"] as const;
export const EFFORTS = ["low", "medium", "high"] as const;
export const CONFIDENCES = ["low", "medium", "high"] as const;

// ─── Piezas reutilizables ───────────────────────────────────────────────────

const locationSchema = z.object({
  path: z.string().min(1).meta({ description: "Ruta relativa a la raiz del repositorio." }),
  line: z.number().int().positive().nullish(),
  note: z.string().nullish(),
});

const referenceSchema = z.object({
  title: z.string().min(1),
  url: z.string().meta({
    description: "URL https de la fuente. Debe ser una pagina que verificaste, no inventada.",
  }),
  official: z
    .boolean()
    .nullish()
    .meta({ description: "true si es documentacion oficial del proyecto o del proveedor." }),
});

// ─── Secciones del informe ──────────────────────────────────────────────────

export const summarySchema = z.object({
  health_score: z.number().int().min(0).max(100).meta({
    description: "Salud de mantenimiento del repositorio. 100 = impecable.",
  }),
  headline: z.string().min(1).max(160).meta({
    description: "Una linea que resume el estado del repositorio.",
  }),
  overview: z.string().min(1).meta({
    description: "Opinion general en markdown, 2 a 5 parrafos.",
  }),
});

export const stackItemSchema = z.object({
  name: z.string().min(1),
  version: z.string().nullish(),
  category: z.enum([
    "runtime",
    "language",
    "framework",
    "package-manager",
    "build-tool",
    "ci",
    "infra",
    "database",
    "testing",
  ]),
  evidence: z.string().nullish().meta({ description: "Archivo donde se detecto." }),
});

export const stepSchema = z.object({
  key: z.enum(STEP_KEYS),
  title: z.string().min(1),
  status: z.enum(["completed", "skipped", "failed"]),
  description: z.string().min(1).meta({
    description: "Que se hizo y que se encontro en esta fase. Markdown.",
  }),
  evidence: z.array(z.string()).nullish(),
  skip_reason: z.string().nullish().meta({
    description: "Obligatorio si status es skipped.",
  }),
});

export const appliedUpdateSchema = z.object({
  name: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  bump: z.enum(["patch", "minor"]).meta({
    description: "Solo patch o minor. Un major NUNCA se aplica.",
  }),
  scope: z.enum(["prod", "dev", "peer", "optional"]).nullish(),
  changelog_url: z.string().nullish(),
  rationale: z.string().nullish().meta({
    description: "En que evidencia te basaste para considerarla segura.",
  }),
});

export const deferredUpdateSchema = z.object({
  name: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  bump: z.enum(["major", "minor", "patch"]).nullish(),
  reason: z.string().min(1).meta({ description: "Por que no se aplico." }),
  breaking_changes: z.array(z.string()).nullish(),
  migration_guide_url: z.string().nullish(),
  estimated_effort: z.enum(EFFORTS).nullish(),
});

export const unmaintainedDependencySchema = z.object({
  name: z.string().min(1),
  last_release: z.string().nullish(),
  evidence: z.string().min(1),
  alternative: z.string().nullish(),
});

export const dependencyUpdatesSchema = z.object({
  applied: z.array(appliedUpdateSchema),
  deferred: z.array(deferredUpdateSchema),
  unmaintained: z.array(unmaintainedDependencySchema),
});

export const findingSchema = z.object({
  finding_key: z
    .string()
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*(:[a-zA-Z0-9._-]+)*$/,
      "slug en minusculas, con guiones y dos puntos. Ej: runtime-eol:node:18",
    )
    .meta({
      description:
        "Slug estable y deterministico. El MISMO problema debe producir el MISMO key en auditorias distintas, para poder compararlas en el tiempo.",
    }),
  category: z.enum(FINDING_CATEGORIES),
  severity: z.enum(SEVERITIES).meta({
    description: "Impacto de MANTENIMIENTO, no de seguridad.",
  }),
  effort: z.enum(EFFORTS).nullish(),
  confidence: z.enum(CONFIDENCES).meta({
    description: "Que tan seguro estas. Si no pudiste verificar la evidencia, poné low.",
  }),
  title: z.string().min(1).max(140),
  description: z.string().min(1).meta({ description: "Que pasa y por que importa. Markdown." }),
  recommendation: z.string().min(1).meta({ description: "Que hacer al respecto. Markdown." }),
  locations: z.array(locationSchema).nullish(),
  references: z.array(referenceSchema).nullish(),
});

export const proposedPullRequestSchema = z.object({
  title: z.string().min(1).max(100),
  body: z.string().min(1).meta({ description: "Cuerpo del PR en markdown." }),
  files_changed: z.array(z.string()),
});

export const outOfScopeNoteSchema = z.object({
  area: z.enum(["security", "feature", "architecture", "other"]),
  note: z.string().min(1),
});

// ─── El informe completo ────────────────────────────────────────────────────

export const maintenanceReportSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    audit_type: z.literal("maintenance"),
    summary: summarySchema,
    stack_detected: z.array(stackItemSchema),
    steps: z
      .array(stepSchema)
      .length(STEP_KEYS.length)
      .refine(
        (steps) =>
          steps.every(
            (step, index) =>
              step.key === STEP_KEYS[index] && step.title === STEP_TITLES[step.key],
          ),
        {
          message: "Las fases deben aparecer en el orden definido y con sus titulos literales.",
        },
      ),
    dependency_updates: dependencyUpdatesSchema,
    findings: z.array(findingSchema),
    proposed_pull_request: proposedPullRequestSchema.nullable().meta({
      description: "null si no se aplico ningun cambio al repositorio.",
    }),
    out_of_scope_notes: z.array(outOfScopeNoteSchema),
    limitations: z.array(z.string()).meta({
      description: "Que no pudiste analizar y por que. Se honesto sobre los limites.",
    }),
  })
  .meta({
    // Sin `id`: registrarlo hace que `z.toJSONSchema` emita
    // `{ $ref: "#/$defs/..." }` en la raiz en vez del objeto plano, y los
    // proveedores de structured output esperan el objeto directo.
    title: "Informe de auditoria de mantenimiento",
  });

// ─── Tipos inferidos ────────────────────────────────────────────────────────

export type MaintenanceReport = z.infer<typeof maintenanceReportSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type Step = z.infer<typeof stepSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type AppliedUpdate = z.infer<typeof appliedUpdateSchema>;
export type DeferredUpdate = z.infer<typeof deferredUpdateSchema>;
export type ProposedPullRequest = z.infer<typeof proposedPullRequestSchema>;
export type StackItem = z.infer<typeof stackItemSchema>;
export type Location = z.infer<typeof locationSchema>;
export type Reference = z.infer<typeof referenceSchema>;
