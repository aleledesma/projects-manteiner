/**
 * @manteiner/contracts
 *
 * Fuente de verdad del contrato entre la app y el agente. Lo consumen:
 *   - la API      -> validacion del informe que devuelve el agente
 *   - el runner   -> JSON Schema para structured output
 *   - la web      -> tipos de lo que muestra
 *
 * Una sola definicion, tres consumidores: no se pueden desincronizar.
 */

export {
  SCHEMA_VERSION,
  STEP_KEYS,
  STEP_TITLES,
  FINDING_CATEGORIES,
  SEVERITIES,
  EFFORTS,
  CONFIDENCES,
  maintenanceReportSchema,
  summarySchema,
  stackItemSchema,
  stepSchema,
  findingSchema,
  appliedUpdateSchema,
  deferredUpdateSchema,
  unmaintainedDependencySchema,
  dependencyUpdatesSchema,
  proposedPullRequestSchema,
  outOfScopeNoteSchema,
} from "./maintenance-report.ts";

export type {
  MaintenanceReport,
  Summary,
  Step,
  StepKey,
  Finding,
  AppliedUpdate,
  DeferredUpdate,
  ProposedPullRequest,
  StackItem,
  Location,
  Reference,
} from "./maintenance-report.ts";

export {
  buildMaintenanceReportJsonSchema,
  buildStrictMaintenanceReportJsonSchema,
  jsonSchemaSizeBytes,
} from "./json-schema.ts";

export type { JsonSchema, BuildOptions } from "./json-schema.ts";

export { normalizeReport } from "./normalize.ts";
export type { NormalizeResult, Warning } from "./normalize.ts";

export { AGENT_VERSION, buildMaintenancePrompt, maintenancePromptTemplate } from "./prompt.ts";
export type { PromptContext } from "./prompt.ts";
