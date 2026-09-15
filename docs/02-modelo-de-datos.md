# 02 — Modelo de datos (SQLite)

## Criterios

- 🟢 SQLite, un solo archivo (`data/manteiner.db`), acceso vía **better-sqlite3** (síncrono) y **Drizzle ORM** para tipado y migraciones.
- 🟢 `PRAGMA journal_mode = WAL` + `PRAGMA foreign_keys = ON` + `PRAGMA busy_timeout = 5000` al abrir la conexión. WAL es lo que permite leer mientras un run escribe.
- 🟢 IDs de la app: texto (UUIDv7 o `nanoid`), no autoincrementales. Facilita exponerlos en URLs y logs sin filtrar volumen.
- 🟢 Timestamps: enteros Unix en **milisegundos** (`INTEGER`). SQLite no tiene tipo fecha; unificar evita ambigüedad de zona horaria.
- 🟢 JSON: columnas `TEXT` con JSON serializado. SQLite permite consultarlo con `json_extract()` si hace falta.
- 🟢 Nada de borrado en cascada silencioso sobre datos históricos: los runs se conservan aunque se desvincule un repo (`ON DELETE SET NULL` donde corresponda).

## Diagrama de relaciones

```
users ──1:N──> provider_credentials
  │
  ├──1:N──> github_installations ──1:N──> repositories
  │                                            │
  └──────────────────1:N──────────────────────>│
                                               │
                                          1:N  v
                                            runs ──1:N──> run_steps
                                              │
                                              ├──1:N──> run_events
                                              ├──1:N──> run_findings
                                              └──1:N──> run_artifacts
```

## DDL

### `users`

```sql
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  github_id         INTEGER NOT NULL UNIQUE,
  github_login      TEXT    NOT NULL,
  name              TEXT,
  email             TEXT,
  avatar_url        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_login_at     INTEGER
);
```

`github_id` es la identidad estable: el `login` puede cambiar.

### `sessions`

Sesiones de navegador. Cookie `httpOnly` + `secure` + `sameSite=lax` que guarda solo el `id`.

```sql
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,           -- valor aleatorio de 32 bytes, hasheado
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

🟢 Se guarda el **hash** del token de sesión, no el token. Una filtración de la DB no da sesiones válidas.

### `github_installations`

Instalaciones de la GitHub App. Ver [03](./03-autenticacion-github.md).

```sql
CREATE TABLE github_installations (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id    INTEGER NOT NULL UNIQUE,   -- id de GitHub
  account_login      TEXT NOT NULL,             -- user u org donde se instalo
  account_type       TEXT NOT NULL,             -- 'User' | 'Organization'
  repository_selection TEXT NOT NULL,           -- 'all' | 'selected'
  suspended_at       INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
```

No se almacenan installation tokens: se generan on-demand y viven ~1h.

### `repositories`

```sql
CREATE TABLE repositories (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id    TEXT REFERENCES github_installations(id) ON DELETE SET NULL,
  github_repo_id     INTEGER NOT NULL,
  owner              TEXT NOT NULL,
  name               TEXT NOT NULL,
  full_name          TEXT NOT NULL,             -- owner/name
  default_branch     TEXT NOT NULL,
  private            INTEGER NOT NULL DEFAULT 0,
  primary_language   TEXT,
  html_url           TEXT NOT NULL,
  linked_at          INTEGER NOT NULL,
  unlinked_at        INTEGER,                   -- soft delete
  last_run_at        INTEGER,
  UNIQUE (user_id, github_repo_id)
);
CREATE INDEX idx_repos_user ON repositories(user_id) WHERE unlinked_at IS NULL;
```

### `provider_credentials`

Credenciales de proveedores de IA del usuario. Ver [04](./04-proveedores-ia-opencode.md).

```sql
CREATE TABLE provider_credentials (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id        TEXT NOT NULL,             -- id de opencode: 'anthropic', 'openai', 'openrouter'...
  auth_type          TEXT NOT NULL,             -- 'api' | 'oauth'  (ambos en v1)
  label              TEXT,                      -- alias que le pone el usuario
  ciphertext         BLOB NOT NULL,             -- AES-256-GCM del payload JSON
  iv                 BLOB NOT NULL,
  auth_tag           BLOB NOT NULL,
  key_version        INTEGER NOT NULL DEFAULT 1,-- para rotacion de MASTER_KEY
  last_four          TEXT,                      -- ultimos 4 chars, solo para mostrar
  status             TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'invalid' | 'revoked'
  verified_at        INTEGER,
  expires_at         INTEGER,                   -- vencimiento del access token OAuth
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (user_id, provider_id)
);
```

🟢 **El texto plano de la credencial nunca se lee fuera del momento de lanzar un run.**
Las respuestas de la API exponen solo `provider_id`, `label`, `last_four` y `status`.

El `ciphertext` guarda el payload completo que espera `auth.set` de opencode, que varía según
`auth_type`:

```jsonc
// auth_type = 'api'
{ "type": "api", "key": "sk-..." }

// auth_type = 'oauth'   (ej. OpenAI con cuenta ChatGPT Plus)
{ "type": "oauth", "refresh": "...", "access": "...", "expires": 1757900000000, "accountId": "..." }
```

🟢 Guardar el payload con la forma exacta del SDK evita traducciones en el camino crítico: se
descifra y se pasa tal cual a `client.auth.set({ path: { id: provider_id }, body: payload })`.

🟢 Para `oauth`, `expires_at` se mantiene **también como columna** además de dentro del
ciphertext. Así se puede consultar "¿esta credencial necesita refresco?" sin descifrar nada.

Es el vencimiento del **access** token. Medido en OpenAI: **10 días** ([13](./13-hallazgos-spike.md)).
La regla de refresco es `expires_at < now + RUN_TIMEOUT_MS + margen`, no "antes de cada run":
como el refresh token **rota**, refrescar de más multiplica las chances de perder la
credencial. Ver [04](./04-proveedores-ia-opencode.md).

⚠️ El `refresh` token es el activo más sensible de la tabla: sobrevive al `access` y permite
obtener tokens nuevos indefinidamente. Ver la nota sobre rotación en [04](./04-proveedores-ia-opencode.md).

### `user_model_preferences`

Modelo elegido, global o por repositorio.

```sql
CREATE TABLE user_model_preferences (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id      TEXT REFERENCES repositories(id) ON DELETE CASCADE,  -- NULL = default global
  provider_id        TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  small_model_id     TEXT,                      -- modelo barato para titulos/resumenes
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (user_id, repository_id)
);
```

### `runs`

La tabla central.

```sql
CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id      TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,

  audit_type         TEXT NOT NULL,             -- 'maintenance' | 'security' (v2)
  status             TEXT NOT NULL,             -- ver maquina de estados en 01
  trigger            TEXT NOT NULL DEFAULT 'manual',

  provider_id        TEXT NOT NULL,             -- congelados al momento del run:
  model_id           TEXT NOT NULL,             -- el historico debe ser reproducible
  agent_version      TEXT NOT NULL,             -- version del prompt/agente
  schema_version     TEXT NOT NULL,             -- version del contrato de salida

  commit_sha         TEXT,                      -- HEAD del clon
  base_branch        TEXT,

  container_id       TEXT,
  opencode_session_id TEXT,

  result_json        TEXT,                      -- JSON completo validado
  health_score       INTEGER,                   -- desnormalizado para listados
  findings_count     INTEGER NOT NULL DEFAULT 0,
  headline           TEXT,

  pr_number          INTEGER,
  pr_url             TEXT,
  pr_branch          TEXT,

  error_code         TEXT,                      -- ej. 'CONTAINER_OOM', 'SCHEMA_INVALID'
  error_message      TEXT,

  tokens_input       INTEGER,
  tokens_output      INTEGER,
  cost_usd           REAL,

  queued_at          INTEGER NOT NULL,
  started_at         INTEGER,
  finished_at        INTEGER,
  duration_ms        INTEGER
);
CREATE INDEX idx_runs_repo_time ON runs(repository_id, queued_at DESC);
CREATE INDEX idx_runs_user_time ON runs(user_id, queued_at DESC);
CREATE INDEX idx_runs_active ON runs(status)
  WHERE status IN ('queued','preparing','cloning','running','collecting','publishing_pr','generating_report');
```

🟢 `provider_id`, `model_id`, `agent_version` y `schema_version` se **congelan** en el run.
Sin eso el histórico deja de ser interpretable cuando el usuario cambia de modelo o cuando
evolucionamos el prompt.

### `run_steps`

Los pasos que el usuario ve en vivo y en el histórico.

```sql
CREATE TABLE run_steps (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,          -- orden estable
  key                TEXT NOT NULL,             -- 'dependency-research', 'runtime-analysis', ...
  title              TEXT NOT NULL,             -- "Investigacion de dependencias"
  description        TEXT,                      -- markdown, se completa al cerrar el paso
  status             TEXT NOT NULL,             -- 'pending'|'running'|'completed'|'skipped'|'failed'
  evidence_json      TEXT,                      -- array de strings/objetos
  started_at         INTEGER,
  finished_at        INTEGER,
  UNIQUE (run_id, seq)
);
CREATE INDEX idx_steps_run ON run_steps(run_id, seq);
```

### `run_findings`

Hallazgos normalizados. Duplican parte de `runs.result_json` **a propósito**: permiten
listar, filtrar y comparar entre runs sin parsear JSON.

```sql
CREATE TABLE run_findings (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  finding_key        TEXT NOT NULL,             -- estable entre runs -> permite "ya reportado"
  category           TEXT NOT NULL,             -- ver 06
  severity           TEXT NOT NULL,             -- 'info'|'low'|'medium'|'high'
  effort             TEXT,                      -- 'low'|'medium'|'high'
  confidence         TEXT,                      -- 'low'|'medium'|'high'
  title              TEXT NOT NULL,
  description        TEXT,
  recommendation     TEXT,
  locations_json     TEXT,
  references_json    TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_findings_run ON run_findings(run_id);
CREATE INDEX idx_findings_key ON run_findings(finding_key);
```

`finding_key` es un slug determinístico (ej. `runtime-eol:node:18`) que el agente debe
generar. Habilita la vista "esto ya te lo dijimos el mes pasado y sigue igual".

### `run_events`

Log append-only para reproducir el progreso al reconectar. Ver [07](./07-progreso-sse.md).

```sql
CREATE TABLE run_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,  -- es el Last-Event-ID de SSE
  run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type               TEXT NOT NULL,
  payload_json       TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_events_run ON run_events(run_id, id);
```

🟢 Acá el autoincremental **sí** es correcto: necesitamos un cursor monótono para `Last-Event-ID`.

### `run_artifacts`

```sql
CREATE TABLE run_artifacts (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL,             -- 'report_pdf' | 'result_json' | 'patch' | 'agent_log'
  path               TEXT NOT NULL,             -- relativo a ARTIFACTS_DIR
  filename           TEXT NOT NULL,
  mime_type          TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  sha256             TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_run ON run_artifacts(run_id);
```

Los binarios van al **filesystem**, no a SQLite. La DB guarda la referencia.

## Retención — 🟡 propuesto

| Dato | Retención |
|------|-----------|
| `run_events` | 30 días (es el detalle fino; el resumen vive en `run_steps`). |
| Workspaces | No existen en el filesystem de la app. Volumen de Docker destruido con el run, siempre ([05](./05-ejecucion-en-docker.md)). |
| `run_artifacts` (PDF/JSON) | Indefinido hasta que el usuario borre el run. |
| `sessions` expiradas | Limpieza diaria. |

## Migraciones

🟢 Drizzle Kit genera SQL versionado en `apps/api/src/db/migrations/`. Se aplican al
arrancar la API, dentro de una transacción. **Nunca** `db.push` en algo que no sea desarrollo local.
