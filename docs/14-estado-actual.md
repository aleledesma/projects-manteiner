# 14 — Estado actual (handoff)

**Fecha: 2026-09-17.** Punto de traspaso a otro agente. Este documento es el que hay que leer
primero para retomar el trabajo.

---

## Resumen en una línea

Fases 0, 1 y 2 cerradas. Fase 3 backend funcional y Fase 4 backend completa; el onboarding web
(V2) ya está construido y las UI de repos y settings siguen diferidas. La API conecta OpenAI por
device flow, cifra credenciales, refresca OAuth con rotación segura, obtiene catálogo mediante un
contenedor opencode efímero, valida API keys y guarda la selección de modelo global o por
repositorio. El siguiente trabajo backend es la Fase 5.

## Qué está hecho y funcionando

| | Estado | Verificación |
|---|---|---|
| Planificación completa (docs 00-13) | ✅ | 5 revisiones registradas |
| Fase 0 — spikes de verificación | ✅ cerrada | [13](./13-hallazgos-spike.md) |
| Monorepo npm workspaces | ✅ | `apps/api`, `apps/web`, `packages/contracts`, `spikes` |
| API Fastify + config + errores + logging + SQLite + cifrado + auth + Docker | ✅ | 66 tests |
| `packages/contracts` | ✅ | 50 tests |
| Contrato base verificado contra opencode real | ✅ | I5 cerrado; hardening posterior cubierto localmente |
| Base de datos SQLite | ✅ | 15 tablas + 3 migraciones |
| Cifrado AES-256-GCM | ✅ | IV aleatorio + AAD + 10 tests específicos |
| Fase 2 — Better Auth + web mínima | ✅ cerrada | Smoke test real completado |
| Fase 3 — GitHub App y repositorios | 🟡 | Backend, sync on-demand y clon real verificados; UI de repos aun diferida |
| Conexión Dockerode | ✅ | Detección local + `ping`/`version`; `/api/health` expone solo disponibilidad |
| Token de clon por repositorio | ✅ | `contents: read`, un `repository_id`, sin caché; revocado tras clonar |
| Imagen `manteiner-git` | ✅ | Build y clon real verificados; corre como UID 10001 |
| Workspace efímero | ✅ | Tamaño previo + Dockerode + callback + limpieza real verificada |
| Fase 4 — proveedores de IA | 🟡 | Backend completo; onboarding (V2) construido, UI de settings diferida |
| V2 — Onboarding web | ✅ | 3 pasos contra la API real; typecheck y build limpios |
| V7 — Configuración web | 🟡 | Proveedores, modelo, catálogo, GitHub y cuenta; sin borrado de cuenta |
| Fase 5 — Contenedor y agente | ✅ | Backend + UI: dashboard (V3), informe (V5) e histórico del repo |
| Fases 5 a 9 | 🔲 | [roadmap](./11-roadmap.md) |

**Comprobalo:**

```bash
npm ci && npm test             # 135/135 (77 api + 8 runner + 50 contracts)
npm run typecheck              # limpio
npm run dev                    # curl http://localhost:3001/api/health
```

## Lo que sigue, en orden

### Próxima sesión: Fase 6 — streaming SSE

El flujo está completo de punta a punta: se vincula un repositorio, se dispara la auditoría
desde el dashboard, el agente corre en su contenedor y el informe se lee en la UI.

Lo que sigue es reemplazar el polling por streaming:

1. Traductor de eventos opencode → eventos de dominio.
2. `run_events` + Event Bus con fan-out y `GET /api/runs/:id/events`.
3. Sustituir el polling de `RepositoriesView` y `RunView` por un `EventSource`.
4. La vista **V4 — Run en vivo** (diseño `02 Run en vivo.dc.html`) recién tiene sentido acá:
   hoy no hay de dónde sacar el paso actual ni la herramienta en uso.

Después, Fase 7 (Pull Requests) habilita el visor de diff (V8) y el chip de PR en las tarjetas.

Lo que **no** hay que rehacer: runner, orquestador, limpieza de huérfanos, validación del
structured output, dashboard, informe e histórico. Están implementados y con tests.

El onboarding (V2) ya está construido: cubre los tres pasos y aparece solo mientras `/api/me`
reporte algo incompleto. Lo que sigue diferido es la UI de **configuración** (V7) y la de
**repositorios** (V3/V9). La imagen base ya fue adelantada y verificada; no hay que reemplazarla
por otro runtime.

I9 (calibración del tamaño) e I10 (comprobación de que el token no aparece en `/proc`) quedan
diferidos hasta que el flujo de ejecución completo sea funcional; no bloquean el desarrollo actual.

Tampoco implementar ahora webhooks ni la UI definitiva de repositorios: ambas decisiones ya
quedaron diferidas para priorizar el flujo funcional.

### Últimos commits estables

- `9833444 feat: sync GitHub repositories on demand`
- `fcfeb52 feat: orchestrate ephemeral repository workspaces`
- `eecf8a6 feat: add secure repository cloning image`

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
  services/docker-helpers.ts   Etiquetas, deadlines y demultiplexado de logs de Docker.
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
  prompts/maintenance.v1.md   <- FUENTE DE VERDAD del prompt (el doc 06 tiene una copia)
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
npm test                                              # 116 tests
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
