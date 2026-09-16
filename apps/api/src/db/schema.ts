import type { MaintenanceReport } from "@manteiner/contracts";
import { sql } from "drizzle-orm";
import { blob, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  githubId: integer("github_id").notNull().unique(),
  githubLogin: text("github_login").notNull(),
  name: text("name"),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastLoginAt: integer("last_login_at"),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (table) => [
    index("idx_sessions_user").on(table.userId),
    index("idx_sessions_expires").on(table.expiresAt),
  ],
);

export const githubInstallations = sqliteTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull().unique(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type", { enum: ["User", "Organization"] }).notNull(),
    repositorySelection: text("repository_selection", { enum: ["all", "selected"] }).notNull(),
    suspendedAt: integer("suspended_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_github_installations_user").on(table.userId)],
);

export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationId: text("installation_id").references(() => githubInstallations.id, {
      onDelete: "set null",
    }),
    githubRepoId: integer("github_repo_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    private: integer("private", { mode: "boolean" }).notNull().default(false),
    primaryLanguage: text("primary_language"),
    htmlUrl: text("html_url").notNull(),
    linkedAt: integer("linked_at").notNull(),
    unlinkedAt: integer("unlinked_at"),
    lastRunAt: integer("last_run_at"),
  },
  (table) => [
    uniqueIndex("idx_repositories_user_github_repo").on(table.userId, table.githubRepoId),
    index("idx_repos_user")
      .on(table.userId)
      .where(sql`${table.unlinkedAt} is null`),
  ],
);

export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    authType: text("auth_type", { enum: ["api", "oauth"] }).notNull(),
    label: text("label"),
    ciphertext: blob("ciphertext", { mode: "buffer" }).notNull(),
    iv: blob("iv", { mode: "buffer" }).notNull(),
    authTag: blob("auth_tag", { mode: "buffer" }).notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    lastFour: text("last_four"),
    status: text("status", { enum: ["active", "invalid", "revoked"] })
      .notNull()
      .default("active"),
    verifiedAt: integer("verified_at"),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_provider_credentials_user_provider").on(table.userId, table.providerId),
  ],
);

export const userModelPreferences = sqliteTable(
  "user_model_preferences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    smallModelId: text("small_model_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_model_preferences_global")
      .on(table.userId)
      .where(sql`${table.repositoryId} is null`),
    uniqueIndex("idx_model_preferences_repository")
      .on(table.userId, table.repositoryId)
      .where(sql`${table.repositoryId} is not null`),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    auditType: text("audit_type", { enum: ["maintenance", "security"] }).notNull(),
    status: text("status", {
      enum: [
        "queued",
        "preparing",
        "cloning",
        "running",
        "collecting",
        "publishing_pr",
        "generating_report",
        "completed",
        "failed",
        "timed_out",
        "cancelled",
      ],
    }).notNull(),
    trigger: text("trigger", { enum: ["manual"] }).notNull().default("manual"),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    agentVersion: text("agent_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    commitSha: text("commit_sha"),
    baseBranch: text("base_branch"),
    containerId: text("container_id"),
    opencodeSessionId: text("opencode_session_id"),
    resultJson: text("result_json", { mode: "json" }).$type<MaintenanceReport>(),
    healthScore: integer("health_score"),
    findingsCount: integer("findings_count").notNull().default(0),
    headline: text("headline"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    prBranch: text("pr_branch"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),
    costUsd: real("cost_usd"),
    queuedAt: integer("queued_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    index("idx_runs_repo_time").on(table.repositoryId, sql`${table.queuedAt} desc`),
    index("idx_runs_user_time").on(table.userId, sql`${table.queuedAt} desc`),
    index("idx_runs_active")
      .on(table.status)
      .where(
        sql`${table.status} in ('queued','preparing','cloning','running','collecting','publishing_pr','generating_report')`,
      ),
  ],
);

export const runSteps = sqliteTable(
  "run_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    key: text("key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", {
      enum: ["pending", "running", "completed", "skipped", "failed"],
    }).notNull(),
    evidenceJson: text("evidence_json", { mode: "json" }).$type<unknown[]>(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    uniqueIndex("idx_run_steps_run_seq").on(table.runId, table.seq),
    index("idx_steps_run").on(table.runId, table.seq),
  ],
);

export const runFindings = sqliteTable(
  "run_findings",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    findingKey: text("finding_key").notNull(),
    category: text("category").notNull(),
    severity: text("severity", { enum: ["info", "low", "medium", "high"] }).notNull(),
    effort: text("effort", { enum: ["low", "medium", "high"] }),
    confidence: text("confidence", { enum: ["low", "medium", "high"] }),
    title: text("title").notNull(),
    description: text("description"),
    recommendation: text("recommendation"),
    locationsJson: text("locations_json", { mode: "json" }).$type<unknown[]>(),
    referencesJson: text("references_json", { mode: "json" }).$type<unknown[]>(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_findings_run").on(table.runId),
    index("idx_findings_key").on(table.findingKey),
  ],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payloadJson: text("payload_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_events_run").on(table.runId, table.id)],
);

export const runArtifacts = sqliteTable(
  "run_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["report_pdf", "result_json", "patch", "agent_log"] }).notNull(),
    path: text("path").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_artifacts_run").on(table.runId)],
);
