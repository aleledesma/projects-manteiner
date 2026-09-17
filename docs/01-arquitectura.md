# 01 — Arquitectura

## Vista general

```
+----------------------------------------------------------------------------+
|  Navegador (SPA React)                                                      |
|  - Login GitHub   - Conectar proveedor IA   - Vincular repos                |
|  - Disparar run   - Progreso en vivo (EventSource)   - Historico + PDF      |
+---------------------------------+------------------------------------------+
                                  | HTTP + SSE
+---------------------------------v------------------------------------------+
|  API (Node + TypeScript, proceso de larga duracion)                         |
|                                                                             |
|  +--------+  +---------+  +---------+  +-----------+  +------------------+  |
|  |  Auth  |  | GitHub  |  | Crypto  |  | Run Queue |  |    Event Bus     |  |
|  |Better  |  | Service |  | AES-GCM |  | in-proc   |  |  fan-out -> SSE  |  |
|  | Auth   |  |         |  |         |  |           |  |                  |  |
|  +--------+  +---------+  +---------+  +-----+-----+  +---------+--------+  |
|                                              |                  |           |
|                                        +-----v------------------v--------+  |
|                                        |         Orquestador             |  |
|                                        |  clona -> lanza -> escucha ->   |  |
|                                        |  recolecta -> PR -> PDF         |  |
|                                        +-----+---------------------------+  |
|           +------------------+               |                              |
|           |      SQLite      |<--------------+                              |
|           | better-sqlite3   |                                              |
|           |   + Drizzle      |                                              |
|           +------------------+                                              |
+----------+--------------------------------------+--------------------------+
           | Docker Engine API                     | REST
           | (dockerode, socket local)             |
+----------v---------------------------------+   +---------v---------------+
|  3 contenedores efimeros, 1 volumen Docker  |   |  GitHub API             |
|                                             |   |  (installation token)   |
|  (1) manteiner-git   clone    [TOKEN]       |   +-------------------------+
|  (2) manteiner-agent opencode serve :4096   |
|         +- agente maintainer   [SIN TOKEN] -+-->+-------------------------+
|  (3) manteiner-git   publish  [TOKEN]       |   |  Proveedor de IA        |
|                                             |   |  (credencial del user)  |
|  volumen /work/repo -> destruido con el run |   +-------------------------+
+---------------------------------------------+
```

🟢 **El repositorio nunca vive en el filesystem de la aplicación.** Se clona en un volumen
efímero de Docker, dentro de su disco virtual, que se destruye con el run. El token y el LLM
nunca coexisten en el mismo contenedor. Ver [05](./05-ejecucion-en-docker.md).

## Stack — 🟢 decidido

| Capa | Elección | Por qué |
|------|----------|---------|
| Lenguaje | **TypeScript** en todo | Tipos compartidos entre API, runner y web; el SDK de opencode es TS. |
| Runtime | **Node 22 LTS** | Estable y compatible con el SDK. |
| API | **Fastify** | Ligero, SSE sencillo, buen sistema de plugins y hooks. |
| Autenticación | **Better Auth** | OAuth de GitHub, sesiones y cookies sin implementar criptografía de autenticación propia. |
| Frontend | **React + Vite** | Sin complejidad de SSR; el estado vive en el backend. |
| Routing web | **React Router** (modo declarativo) | Lo más simple y popular. Paquete `react-router`, sin SSR ni loaders. |
| ORM / DB | **Drizzle ORM + better-sqlite3** | Migraciones versionadas, tipado, SQLite síncrono y rápido. |
| Docker | **dockerode** | Cliente maduro de la Engine API; control fino de límites y streams. |
| Agente | **@opencode-ai/sdk** | Requisito del proyecto. |
| Validación | **Zod** | Un esquema para validar y para derivar el JSON Schema del agente. |
| PDF | **@react-pdf/renderer** | Sin dependencia de Chromium. Ver [08](./08-reportes-pdf.md). |

### Por qué no Next.js

Next.js sería razonable, pero esta app es **pesada de backend**: orquestación de
Docker, colas, procesos largos y streams. Separar `apps/api` y `apps/web` deja cada
pieza explícita y fácil de entender de a una — que es el objetivo declarado de
construir paso a paso. Decisión cerrada: ver A1 en [12](./12-decisiones-abiertas.md).

### Publicación web

En producción la SPA y `/api` se publican bajo **el mismo origen**. Un reverse proxy sirve los
archivos de `apps/web/dist` y envía `/api/*` a Fastify. Esto mantiene las cookies host-only y
evita sumar CORS o cookies cross-site; `PUBLIC_URL` y `WEB_URL` deben compartir origen.

## Estructura de carpetas — 🟢 decidida

```
manteiner/
  docs/                       # esta documentacion
  apps/
    api/                      # Fastify + orquestador + SQLite
      src/
        routes/               # HTTP + SSE
        services/             # github, crypto, providers, reports
        orchestrator/         # docker, workspace, ciclo de vida del run
        db/                   # schema drizzle + migraciones
        events/               # event bus + mapeo de eventos opencode
    web/                      # React + Vite
  packages/
    contracts/                # Zod + JSON Schema del output del agente (compartido)
    agent-runner/             # codigo que corre DENTRO del contenedor
  docker/
    agent/Dockerfile          # manteiner-agent: node + opencode + runner
    git/Dockerfile            # manteiner-git: git puro, para clonar y publicar
  data/                       # SQLite y PDFs (gitignored). NUNCA repositorios.
```

`packages/contracts` es la pieza clave: define el contrato de salida del agente una
sola vez y lo consumen la API (validación), el runner (structured output) y la web (tipos).

## Flujo completo de una ejecución

```
 1. POST /api/repos/:id/runs      -> crea run (status: queued), devuelve runId
 2. Encola el run                 -> la cola in-process toma el siguiente slot libre
 3. status: preparing
    - descifra la credencial del proveedor; si es OAuth y esta por vencer, la refresca
    - genera installation token de GitHub (vive ~1h, scope: ese repo)
    - chequeo de tamaño del repo (GitHub API) + docker volume create
 4. status: cloning
    - CONTENEDOR 1 (manteiner-git): recibe el token por stdin, clona --depth 1
      en el volumen, borra el remote y las credenciales, registra base_sha, y termina
 5. status: running
    - CONTENEDOR 2 (manteiner-agent): monta el mismo volumen, SIN token de GitHub
    - el runner arranca `opencode serve` dentro del contenedor
    - la API se conecta a ese servidor, carga la credencial del proveedor con auth.set
    - crea la sesion y envia el prompt con `format: json_schema`
    - se suscribe a client.event.subscribe()  ---+
 6. (durante la ejecucion)                       |
    - mapea eventos opencode -> eventos dominio -+
    - persiste steps/eventos en SQLite ----------+
    - fan-out a los navegadores conectados (SSE)-+
 7. status: collecting
    - lee `info.structured` del resultado
    - valida contra el JSON Schema; si falla -> reintento acotado
    - lee `git diff` del volumen por exec (solo texto, a memoria)
    - docker stop + docker rm del contenedor 2
 8. status: publishing_pr        (si hay diff y el agente propuso PR)
    - CONTENEDOR 3 (manteiner-git): token fresco por stdin, filtra el diff contra la
      allowlist, crea la rama, commitea y pushea
    - el orquestador hace el POST /pulls
 9. status: generating_report
    - renderiza el PDF a partir del JSON estructurado
10. status: completed
    - evento final por SSE; el historico queda disponible
```

Cualquier fallo lleva a `failed` (o `timed_out` / `cancelled`) y **siempre** pasa por la
limpieza final: los tres contenedores destruidos y el volumen eliminado. El repositorio deja
de existir en cualquier forma.

## Ciclo de vida del run (máquina de estados)

```
queued -> preparing -> cloning -> running -> collecting -> publishing_pr
                                                |                |
                                                |                v
                                                +---> generating_report -> completed

  cualquier estado -> failed | timed_out | cancelled
```

Reglas:

- 🟢 Un run **nunca** vuelve a un estado anterior. Si hay que reintentar, es un run nuevo.
- 🟢 `publishing_pr` y `generating_report` son opcionales: si no hay diff, se saltea el PR.
- 🟢 Un fallo en el PDF **no** invalida el run: queda `completed` con el artefacto ausente y un warning.
- 🟢 Un solo run activo por repositorio a la vez (evita PRs duplicados y carreras sobre el workspace).

## Concurrencia

v1 usa una **cola in-process** con un límite de N runs concurrentes
(`MAX_CONCURRENT_RUNS`, default 2), porque cada run levanta un contenedor con CPU y
memoria reservadas. No hay Redis ni worker externo: el proceso de la API es el worker.

Consecuencia asumida 🟢: si el proceso se reinicia con runs en vuelo, esos runs quedan
huérfanos. Al arrancar, la API marca como `failed` todo run en estado no terminal y
hace `docker rm` de los contenedores etiquetados `manteiner.run=*` que hayan quedado.

## Configuración por entorno

| Variable | Descripción |
|----------|-------------|
| `PORT`, `PUBLIC_URL`, `WEB_URL` | Puerto, URL pública de la API y origen permitido de la web. |
| `DATABASE_PATH` | Ruta del archivo SQLite. |
| `MASTER_KEY` | Clave de 32 bytes (base64) para cifrar credenciales. Ver [10](./10-seguridad.md). |
| `SESSION_SECRET` | Firma cookies y protege los artefactos internos de Better Auth. |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | Login de usuarios. |
| `GITHUB_APP_ID`, `_SLUG`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_PRIVATE_KEY_BASE64` | GitHub App para acceso a repos. |
| `DOCKER_SOCKET` | Override opcional; Dockerode respeta `DOCKER_HOST` o descubre el socket local. |
| `DOCKER_API_TIMEOUT_MS` | Timeout para llamadas al daemon. Default `3000`. |
| `GITHUB_API_TIMEOUT_MS` | Timeout para llamadas a la API de GitHub. Default `10000`. |
| `AGENT_IMAGE`, `GIT_IMAGE` | Tags de las dos imágenes, ej. `manteiner-agent:0.1.0`. |
| `CLONE_TIMEOUT_MS` | Tiempo máximo del contenedor de clonado. Default `300000` (5 min). |
| `WORKSPACE_BACKEND` | `disk` (default) o `tmpfs`. Ver [05](./05-ejecucion-en-docker.md). |
| `MAX_REPO_SIZE_KB` | Rechaza repos más grandes antes de clonar. Default `2000000`. |
| `WORKSPACE_SIZE` | Solo con `tmpfs`: tamaño del volumen en RAM. Default `2g`. |
| `MAX_CONCURRENT_RUNS` | Default `2`. Con `tmpfs`, multiplica el consumo de RAM. |
| `RUN_TIMEOUT_MS` | Default `1800000` (30 min). |
| `ARTIFACTS_DIR` | Directorio de PDFs. **No hay `WORKSPACE_DIR`**: el repo nunca toca disco. |
| `STORE_PATCH_ARTIFACT` | Default `false`. El PR es el registro canónico del diff. |
