# 14 — Estado actual (handoff)

**Actualizado: 2026-11-02.** Punto de traspaso a otro agente. Este documento es el que hay que leer
primero para retomar el trabajo.

---

## Resumen en una línea

El flujo principal ya está implementado: login GitHub, vinculación de repositorios, proveedores
de IA, auditorías en Docker, dashboard, informe e histórico, progreso SSE y publicación de PRs.
También está implementado el endurecimiento automatizable. La próxima feature es la **Fase 8
(PDF)**; faltan verificaciones integrales reales de SSE/PRs y seguridad manual para cerrar v1.

## Qué está hecho y funcionando

| | Estado | Verificación |
|---|---|---|
| Planificación completa (docs 00-13) | ✅ | 5 revisiones registradas |
| Fase 0 — spikes de verificación | ✅ cerrada | [13](./13-hallazgos-spike.md) |
| Monorepo npm workspaces | ✅ | `apps/api`, `apps/web`, `packages/contracts`, `spikes` |
| API Fastify + config + errores + logging + SQLite + cifrado + auth + Docker | ✅ | Suite automatizada; revalidación local bloqueada por entorno (ver abajo) |
| `packages/contracts` | ✅ | Contrato y normalización con tests |
| Contrato base verificado contra opencode real | ✅ | I5 cerrado; hardening posterior cubierto localmente |
| Base de datos SQLite | ✅ | 15 tablas + 3 migraciones |
| Cifrado AES-256-GCM | ✅ | IV aleatorio + AAD + 10 tests específicos |
| Fase 2 — Better Auth + web mínima | ✅ cerrada | Smoke test real completado |
| Fase 3 — GitHub App y repositorios | 🟡 | Backend, sync on-demand, clon real y UI implementados; I9/I10 pendientes |
| Conexión Dockerode | ✅ | Detección local + `ping`/`version`; `/api/health` expone solo disponibilidad |
| Token de clon por repositorio | ✅ | `contents: read`, un `repository_id`, sin caché; revocado tras clonar |
| Imagen `manteiner-git` | ✅ | Build y clon real verificados; corre como UID 10001 |
| Workspace efímero | ✅ | Tamaño previo + Dockerode + callback + limpieza real verificada |
| Fase 4 — proveedores de IA | ✅ | Backend, onboarding (V2) y configuración (V7) implementados |
| V2 — Onboarding web | ✅ | 3 pasos contra la API real; typecheck y build limpios |
| V7 — Configuración web | 🟡 | Proveedores, modelo, catálogo, GitHub y cuenta; sin borrado de cuenta |
| Fase 5 — Contenedor y agente | ✅ | Backend + UI: dashboard (V3), informe (V5) e histórico del repo |
| Fase 6 — Streaming SSE | 🟡 | Bus, traductor, endpoint y vista en vivo (V4); sin verificar contra un run real |
| Fase 7 — Pull Requests | 🟡 | `publish.sh`, `assertPushTarget`, `POST /pulls` y UI; falta verificar contra un repo real |
| Fase 8 — PDF | 🔜 | Próxima feature |
| Fase 9 — Endurecimiento | 🟡 | Rate limit, cola de runs (2 simultáneos), redacción de secretos y rotación de `MASTER_KEY`; quedan verificaciones manuales |

**Comprobalo:**

```bash
npm ci                        # con Node >= 22.12 activo
npm test                      # 187/187 (123 API + 8 runner + 56 contracts)
npm run typecheck              # verificado limpio el 2026-11-02
npm run dev                    # curl http://localhost:3001/api/health
```

### Estado de verificación

**Última verificación local (2026-11-02, `maintenance@2`):** con Node **24.15.0**, pasan
**187/187 tests (123 API + 8 runner + 56 contracts)** y el typecheck de todos los workspaces.
Se usaron `npm.cmd test` y `npm.cmd run typecheck` porque PowerShell bloquea `npm.ps1` por
su política de ejecución; no se cambió esa política. Los tests nuevos cubren las instrucciones
del prompt y publicación con limitaciones; no sustituyen una ejecución real del LLM.

El bloqueo anterior se debía al Node **20.20.2** activo: además de la ABI incompatible de
`better-sqlite3` y el glob de tests, no cargaba algunas variables existentes del `.env`.
El mismo archivo valida completo con Node 24.15.0. No se cambiaron secretos ni fue necesario
modificar el `.env`; ante la repetición del error, comprobar `node -v` y `nvm use 24.15.0`.

## Lo que sigue

### Agente actualizado: `maintenance@2`

La política activa ahora exige aplicar patches/minors compatibles y proponer un PR con los
cambios reales. La falta de tests, CI, cobertura o servicios externos se documenta en el
informe y PR; no bloquea actualizaciones por sí sola. Se difieren por candidato los breaking
changes, migraciones de código o regresiones concretas, conservando los otros cambios.
Si `latest` es otro major, también se busca una versión compatible del major actual.

La fuente activa es `packages/contracts/src/prompts/maintenance.v2.md`; la v1 se conserva para
el histórico y los nuevos runs guardan `maintenance@2`. No cambió el schema ni el filtro del
publicador. El prompt se envía desde la API en cada run: reiniciar la API y lanzar una auditoría
nueva alcanza, sin reconstruir imágenes. Los runs existentes no se reejecutan ni se modifican.

### Diagnóstico de clonado (`CLONE_FAILED`, exit 128)

El primer intento con `maintenance@2` falló antes de iniciar el agente. El runtime descartaba
el stderr que ya había leído del contenedor y persistía solo `exitCode`; ese fallo de diagnóstico
está corregido para clonado y publicación. Ahora se guarda el stderr de Git, redactando el token
exacto y patrones de secretos antes de limitarlo a 8.192 caracteres. Si falla la lectura de logs,
se conserva el código de salida original. Hay tests de redacción, límite y limpieza de recursos.

Una prueba posterior de **solo clonado** del mismo repositorio funcionó (2.764 KB) y eliminó el
workspace. No se lanzó un LLM ni un PR ni se alteró el run fallido. La causa del fallo original
no se pudo recuperar porque el contenedor ya había sido eliminado; no asumir error de permisos
o de red sin evidencia. Para un nuevo intento, reiniciar la API; no requiere rebuild de Docker.

### Publicación de PR: imagen Git y contexto de build

El run siguiente sí aplicó `sonner` 2.0.7 → 2.0.8 y propuso un PR, pero la imagen local
`manteiner-git:0.1.0` era anterior a la publicación y no contenía `/usr/local/bin/publish.sh`.
Se reprodujo el fallo de inicio del contenedor sin credenciales ni red: el push nunca llegó a GitHub.

Al reconstruir se encontró otro defecto: `docker/git/.dockerignore` permitía solo `Dockerfile`
y `clone.sh`, excluyendo `publish.sh` del contexto. Se agregó `!publish.sh`, se reconstruyó
correctamente con `npm.cmd run docker:build:git` y se comprobó en la imagen que ambos scripts
existen, son ejecutables y pasan `sh -n`. No se hizo push ni se reejecutó la auditoría.
La próxima auditoría usará la imagen reconstruida; este rebuild es necesario para publicación,
no por el cambio de prompt v2.

### Revisión para publicación del repositorio

Revisión del **2026-11-02**: el proyecto puede presentarse como trabajo de portfolio **en
desarrollo**, no como servicio listo para producción. Publicar código y exponer una instancia
son decisiones distintas. No se cambió la visibilidad del repositorio ni se hizo push.

- Búsqueda por patrones comunes sobre todos los objetos alcanzables por refs Git locales:
  676 objetos, 419 blobs; la única coincidencia fue un token ficticio de tests de redacción.
  No se encontraron archivos `.env`, PEM, claves, SQLite, `data/` o `spikes/.out/` en el historial
  consultado. Es una revisión acotada, no una certificación de ausencia de secretos; antes de
  cambiar la visibilidad se recomienda un escáner dedicado sobre todos los refs remotos.
- No hay `LICENSE` ni pipeline de CI. La licencia requiere elección del autor. Conviene agregar
  capturas reales o una demo sin datos sensibles para el portfolio.
- `npm audit --omit=dev --json` reportó **13 paquetes con avisos: 1 crítico, 4 altos,
  6 moderados y 2 bajos**. Incluye Better Auth (crítico, [GHSA-965c-763c-88jm](https://github.com/advisories/GHSA-965c-763c-88jm)),
  además de avisos en dependencias directas y transitivas. La aplicabilidad de cada aviso aún
  debe evaluarse; no se actualizaron paquetes ni se ejecutó `audit fix`.
- Se corrigieron afirmaciones desactualizadas de `docs/10-seguridad.md`: el agente permite
  shell/lectura/escritura; la allowlist efectiva se aplica al publicar, no al editar dentro del agente.
- El README ahora incluye propuesta de valor, stack, instalación completa y diagramas Mermaid,
  además de estado, limitaciones y licencia pendiente. No se agregaron badges de CI ficticios.

### Verificaciones antes de cerrar v1

1. Mantener Node y dependencias compatibles al revalidar (suite automatizada actual: 187/187).
2. Ejecutar una auditoría real y comprobar SSE, reconexión/F5 y cierre del stream.
3. Crear un PR real con la GitHub App autorizada para `contents` y `pull_requests` en Read & Write.
4. Completar I9 (calibración del tamaño de clones) e I10 (token fuera de `inspect` y `/proc`).
5. Probar un repo con prompt injection y recorrer los puntos manuales de [10](./10-seguridad.md).
6. Evaluar y resolver los avisos de dependencias aplicables antes de exponer una instancia.

### Próxima feature: Fase 8 — PDF

- Plantilla del informe según [08](./08-reportes-pdf.md).
- Persistencia de `run_artifacts`, descarga autorizada y regeneración.
- El informe web y el histórico ya existen: no hay que reconstruirlos.

### Implementado: no rehacer

Runner, orquestador, limpieza de huérfanos, validación de structured output, onboarding,
configuración, dashboard, informe, histórico, SSE y publicación de PRs están implementados.
El onboarding aparece mientras `/api/me` reporte pasos incompletos. Configuración todavía no
incluye borrado de cuenta. No confundir implementación con las verificaciones pendientes.

Los webhooks siguen diferidos: la sincronización de repositorios es on-demand. El resto del
backlog post-v1 está en [11](./11-roadmap.md).

### Último trabajo de producto y ramas

- `fce8cd9` (2026-10-20): rate limiting, cola de runs, redacción de secretos y rotación de `MASTER_KEY`.
- `a2a88c7` (2026-10-20): publicación de ramas y apertura de PRs con actualizaciones del agente.
- `d837baf` / `a9f5206` (2026-09-18): progreso en vivo por SSE y ajustes de los puntos de entrada.

La rama de integración es **`dev`**, que reúne el trabajo de `main`, `feat/agent-runner` y
`feat/pull-requests`. Las ramas de features se conservan. Integrar y commitear no implica push:
consultar `git status`, `git branch -vv` y los refs remotos para conocer la sincronización actual.

### Sincronización elegida

A5 quedó resuelta con sincronización on-demand en `GET /api/repos`. Los webhooks quedan diferidos
hasta que exista despliegue público o ejecuciones programadas.

---

## Lo que hay que saber antes de tocar código

Esto es lo que costó descubrir. Está todo en [13](./13-hallazgos-spike.md), pero lo repito acá
porque son las trampas que hacen perder horas.

### Sobre opencode

| Trampa | Realidad |
|--------|----------|
| La doc dice `info.structured_output` | **El campo real es `info.structured`.** Me costó un falso negativo completo. |
| La doc menciona `client.global.health()` | **No existe.** `Global` solo expone `event()`. Usar `client.path.get()` como sonda. |
| Los tipos del SDK parecen la especificación completa | **No lo son.** El runtime emite al menos 6 eventos que no están en la unión `Event`. El `default` del switch es obligatorio. |
| `ALLOWED_MODELS` del código fuente | **No es el catálogo efectivo.** Hay 15 modelos con tool calling, incluido `gpt-5.6-terra`. Leer siempre `config.providers()` autenticado. |
| Con suscripción se puede estimar el costo | **No:** viene `cost: 0`. La estimación solo sirve para proveedores con API key. |

### Sobre `fetch` de Node y las sesiones largas

**Medido el 2026-09-17.** Un `fetch` de Node cuya respuesta tarda en mandar las cabeceras
**muere a los 303 s** con `UND_ERR_HEADERS_TIMEOUT`, que sale como un `fetch failed` sin más
detalle. Es el `headersTimeout` por defecto de undici.

La sesión del agente tarda exactamente eso: `opencode serve` mantiene el pedido HTTP abierto
mientras el modelo trabaja y recién al final responde. Resultado: tres auditorías reales
murieron a los 311 s, 312 s y una sobrevivió con 285 s. `RUN_TIMEOUT_MS` decía 30 minutos y no
servía de nada, porque **el transporte cortaba antes que el deadline de la aplicación**.

🟢 `crearDispatcherLargo()` (en `docker-helpers.ts`) arma un dispatcher con `headersTimeout` y
`bodyTimeout` en `RUN_TIMEOUT_MS + 60 s`, y se pasa como `dispatcher` **solo** en el fetch del
agente. No se toca el dispatcher global: las llamadas a GitHub **sí** tienen que fallar rápido.

⚠️ **Dos callejones sin salida, ya recorridos.** La clase `Agent` hay que sacarla del dispatcher
global de Node (`globalThis[Symbol.for("undici.globalDispatcher.1")].constructor`), no del
paquete `undici`:

| Intento | Qué pasa |
|---|---|
| `new Agent()` del paquete `undici` + `fetch` global | `UND_ERR_INVALID_ARG`: el fetch nativo valida que la instancia sea de **su** undici interno |
| `fetch` del paquete `undici` | `ERR_INVALID_URL: [object Request]`: el SDK de opencode llama `fetch(request)` con un `Request` de Node que ese fetch no reconoce |

⚠️ La regla general: **cualquier deadline de transporte tiene que ser mayor que el deadline de
la aplicación que lo contiene.** Si no, el error que ves no describe lo que pasó.

### Sobre la imagen del agente

⚠️ La imagen **tiene que llevar `git` y un gestor de paquetes**. Estuvo un tiempo sin ninguno de
los dos: el agente corre con `bash: allow` y su trabajo es justamente mirar la historia del repo
y el estado de las dependencias, así que cada comando que intentaba fallaba en silencio y el
diff salía siempre vacío. El doc 05 describía una imagen `node:22-bookworm-slim` que ya no era
la real; hoy es `oven/bun:1.3.10-alpine` + `git ca-certificates curl nodejs npm`.

🟢 También lleva `git config --system --add safe.directory /work/repo`: el volumen viene del
contenedor de clonado con otro dueño y git se niega a operar sobre un repo ajeno.

### Sobre las credenciales de OpenAI

- El access token dura **10 días**; el refresh token **rota en cada uso**.
- Por eso la regla es **refrescar lo menos posible**:
  `if (expires_at < now + RUN_TIMEOUT_MS + margen) refresh()`. Ver R3 en [12](./12-decisiones-abiertas.md).
- Persistir el par nuevo **antes** de usarlo. Si se rota y no se guarda, el usuario pierde la cuenta.
- Hay una credencial real en `spikes/.out/openai-tokens.json` (gitignored). Sirve para probar.

### Sobre Zod 4

- Trae `z.toJSONSchema()` nativo; **no** hace falta `zod-to-json-schema`.
- **No poner `id` en `.meta()`** del schema raíz: emite `{ $ref: "#/$defs/..." }` en vez del objeto
  plano, y los proveedores de structured output esperan el objeto directo.
- `z.object()` **descarta** claves desconocidas, no rechaza. Es el comportamiento que queremos.

### Sobre el entorno (Windows)

- `pkill` de Git Bash **no alcanza** para matar procesos de Node: quedan vivos el `npm` padre y el
  wrapper de tsx. Hay que usar `Stop-Process -Id ... -Force` de PowerShell con los tres PIDs.
- Nunca correr `npm run dev` en foreground desde una herramienta: no termina nunca.
- Escribir archivos con `¿` se corrompió una vez a `ż` (U+017C). Verificar después de escribir.
- La consola es cp1252: imprimir no-ASCII desde Python falla con `UnicodeEncodeError`.

---

## Mapa del repositorio

```
apps/api/src/
  config.ts       Validacion de entorno con Zod. Si falta un secreto, NO arranca.
  db/client.ts    Abre SQLite, aplica PRAGMAs y migraciones, y cierra la conexion.
  db/schema.ts    Schema Drizzle de las 15 tablas.
  db/migrations/ Migraciones SQL versionadas.
  routes/auth.ts  Puente Fastify/Better Auth + GET /api/me.
  routes/github.ts Instalacion de GitHub App, repos disponibles y vinculacion.
  routes/providers.ts OAuth, credenciales, catalogo y preferencias de modelo.
  services/auth.ts Configura GitHub, sesiones y descarte de tokens OAuth.
  services/github-app.ts JWT de App, tokens efimeros y llamadas a GitHub.
  services/docker.ts Conexion al daemon, estado y error DOCKER_UNAVAILABLE.
  services/repository-workspace.ts Tamaño, volumen, clon Dockerode y limpieza garantizada.
  services/credential-crypto.ts  AES-256-GCM para credenciales de proveedores.
  services/openai-oauth.ts Device flow, PKCE, polling y refresh de OpenAI.
  services/provider-credentials.ts Persistencia cifrada, CRUD y refresh persist-before-use.
  services/provider-catalog.ts Cache atomico y validacion de modelos con tool calling.
  services/opencode-runtime.ts Contenedor efimero para catalogo y validacion real.
  services/model-preferences.ts Preferencia global y override por repositorio.
  services/agent-runtime.ts    Contenedor 2: monta el volumen, auth.set por HTTP y dirige la sesion.
  services/run-orchestrator.ts Clona, audita, valida contra contracts y persiste el run.
  services/docker-cleanup.ts   Huerfanos al arrancar: runs vivos, contenedores y volumenes.
  services/docker-helpers.ts   Etiquetas, deadlines, demultiplexado y dispatcher largo.
  services/run-events.ts       Eventos de dominio y bus con fan-out y replay.
  services/opencode-translator.ts Eventos de opencode -> eventos de dominio, con throttle.
  routes/runs.ts  POST /api/repos/:id/runs + lectura de runs.
  errors.ts       AppError + handler unico. Forma { error: { code, message } }.
  server.ts       buildServer(config) -> NO escucha, para que los tests usen inject().
  index.ts        Entrypoint: valida config, arranca, maneja SIGTERM/SIGINT.
  routes/health.ts

packages/agent-runner/src/
  workspace.ts    Genera opencode.json, el agente y la exclusion de .opencode. Puro y testeado.
  index.ts        Entrypoint del contenedor: escribe, levanta opencode y reenvia senales.

packages/contracts/src/
  maintenance-report.ts   Zod del informe. PURO: sin transforms (ver nota abajo).
  normalize.ts            Validaciones semanticas. NO destructivas: corrige y avisa.
  json-schema.ts          z.toJSONSchema() + variante estricta + medicion de tamaño.
  prompt.ts               Carga e interpola el prompt versionado.
  prompts/maintenance.v2.md   <- FUENTE DE VERDAD del prompt activo (maintenance@2)
  prompts/maintenance.v1.md   Plantilla histórica conservada, no usada en nuevos runs.
  fixtures.ts             Informe de ejemplo valido, usado por los tests.

spikes/src/
  01-openai-device-flow.ts   Device flow de OpenAI. Ya ejecutado.
  02-opencode-contract.ts    Contrato contra opencode. Ya ejecutado.
  lib/openai-credential.ts   Carga/refresco de la credencial. Base de la Fase 4.

apps/web/src/
  App.tsx          Ruteo por estado: login -> onboarding -> shell. Sin router.
  auth-client.ts  Cliente React de Better Auth.
  api.ts          fetch tipado + ApiError con el `code` del doc 09.
  useMe.ts        GET /api/me: usuario y estado de onboarding, recargable.
  tiempo.ts       Fechas relativas en es-AR con Intl.RelativeTimeFormat.
  views/LoginView.tsx      V1.
  views/OnboardingView.tsx V2: riel de progreso, 3 pasos y pantalla de cierre.
  views/SettingsView.tsx   V7: nav lateral sticky + cuatro secciones.
  providers/catalogo.ts        Lista curada de opciones de proveedor.
  providers/ConectarProveedor.tsx Tarjetas + rama API key + rama device flow.
  providers/DeviceFlow.tsx     Codigo, cuenta regresiva y polling cada 2s.
  providers/ModelPicker.tsx    Catalogo autenticado, filtro y costo por millon.
  onboarding/StepProvider.tsx  Paso 1: credencial conectada y modelo opcional.
  onboarding/StepGithub.tsx    Permisos explicados antes del redirect.
  onboarding/StepRepos.tsx     Buscador, seleccion masiva y vinculacion.
  settings/Seccion.tsx         Bloque con ancla para la nav lateral.
  settings/SeccionProveedores.tsx Filas, modales de alta, reconexion y borrado.
  settings/SeccionModelo.tsx   Modelo por defecto + estado del catalogo.
  settings/SeccionGithub.tsx   Instalaciones, org vs personal, sincronizar.
  settings/SeccionCuenta.tsx   Identidad y cierre de sesion.

docker/git/
  Dockerfile       Imagen manteiner-git: Alpine + Git, usuario 10001.
  clone.sh         Clon depth 1; token por stdin/FIFO; elimina origin.
docker/agent/
  Dockerfile       Base opencode 1.18.30, usuario 10001; reutilizable por Fase 5.
```

### Tres invariantes que no hay que romper

1. **`maintenance-report.ts` no lleva transforms ni `.default()`.** `z.toJSONSchema()` emite el
   tipo de *salida*, así que un transform haría que el JSON Schema publicado difiera de lo que se
   le pide al modelo. Las normalizaciones van en `normalize.ts`, aparte.

2. **`normalize.ts` nunca rechaza un informe entero.** Corrige lo corregible y anota el resto en
   `warnings`. Perder una auditoría de 20 minutos porque una URL era `http` sería absurdo.

3. **Las credenciales nunca salen de la API ni entran en errores/logs.** El catálogo persiste solo
   metadata normalizada; errores del SDK no se encadenan como `cause` porque podrían retener el body
   enviado a `auth.set`.

---

## Comandos útiles

```bash
npm test                                              # requiere Node/dependencias compatibles
npm run typecheck
npm run dev                                           # API en :3001
npm run dev:web                                       # web en :5173
npm run docker:build:git                              # imagen manteiner-git:0.1.0
npm run docker:build:agent                            # imagen manteiner-agent:0.1.0

npm run print-schema --workspace @manteiner/contracts # el JSON Schema del informe
npm run contract --workspace manteiner-spikes -- --dry-run   # verifica sin gastar tokens
npm run contract --workspace manteiner-spikes                # corrida completa contra opencode
npm run device-flow --workspace manteiner-spikes             # re-autenticar OpenAI
```

## Cómo se trabaja en este proyecto

- **Paso a paso.** El usuario quiere entender cada pieza; no construir fases enteras de una.
- **Las decisiones se registran**, incluidas las descartadas y por qué.
  [12](./12-decisiones-abiertas.md) tiene 23 decisiones y 8 revisiones.
- **Verificar antes de construir**, pero solo lo que puede cambiar la arquitectura. El spike 3 se
  salteó aplicando ese criterio; sus preguntas pasaron a criterios de aceptación de las fases 3 y 5.
- **No dejar procesos corriendo.** Verificar por PID después de levantar cualquier servidor.
