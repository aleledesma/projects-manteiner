# 11 — Roadmap de implementación

El orden está pensado para que **cada fase termine en algo que se pueda ejecutar y ver
funcionando**, y para atacar primero el riesgo técnico más alto. No se construye la UI
bonita antes de saber si el agente dentro del contenedor funciona.

Cada fase es una conversación aparte: "construyamos la fase N".

**Estado revisado el 2026-11-02:** el flujo principal y el endurecimiento automatizable están
implementados. La próxima feature es la **Fase 8 (PDF)**; las pruebas reales de SSE/PRs y las
verificaciones manuales de seguridad siguen pendientes. Una fase implementada no implica
aceptación integral cerrada. El detalle operativo está en [14](./14-estado-actual.md).

---

## Fase 0 — Verificación técnica (spike) ✅ CERRADA

**Por qué primero:** todo el diseño apoya sobre supuestos del SDK de opencode que hay que
confirmar antes de escribir código de producción. Si alguno falla, cambia la arquitectura.

Sin app, sin DB, sin UI. Solo scripts descartables en `spikes/`.

- [x] ~~Volcar el OpenAPI de `GET /doc`~~ ✅ **Innecesario:** los tipos generados del SDK (`dist/gen/types.gen.d.ts`) ya son la especificación. 67 endpoints, 32 eventos.
- [x] ~~¿`POST /auth/{id}` acepta `type: "oauth"`?~~ ✅ **Sí.** `Auth.Info = Oauth | Api | WellKnown`.
- [x] ~~¿Endpoint que exponga `authorize()`?~~ ✅ **Sí**, el flujo completo. Habilita v2 sin replicar flujos.
- [x] ~~¿Se puede leer la credencial vigente?~~ ❌ No existe. Irrelevante tras el spike 1.
- [x] ~~Forma de `config.providers()`~~ ✅ `Model.capabilities.toolcall`, `cost`, `limit`, `status`.
- [x] ~~**Device flow de OpenAI de punta a punta**~~ ✅ Funciona. Ver [13](./13-hallazgos-spike.md).
- [>] Confirmar que `opencode serve` arranca **sin** credenciales (I4) -> **movido a Fase 5**.
- [x] ~~Volcar el stream de eventos~~ ✅ Obtenido de los tipos: 32 eventos con payloads exactos. Doc 07 reescrito.
- [>] Probar `format: { type: "json_schema" }` con el schema completo (I5) -> **movido a Fase 1**.
- [>] Probar `permission` con `bash` deny + allowlist (I6) -> **movido a Fase 5**.
- [>] Spike 3 (Docker) -> **salteado**, preguntas reubicadas en las fases 3 y 5.

### Por qué se salteó el spike 3

El criterio de esta fase es *confirmar los supuestos que, si fallan, cambian la arquitectura*.
Las preguntas del spike 3 no califican: en su mayoría son comportamiento documentado de Docker
(un volumen sobrevive entre contenedores secuenciales, `volume rm` borra, `dockerode` habla con
el named pipe). La única con filo era si el token por stdin queda fuera de `docker inspect`, y
si la respuesta fuera "no", cambiaríamos cómo se lo pasamos al contenedor de clonado — no el
diseño.

🟢 Las preguntas no se descartan: pasan a ser **criterios de aceptación** de las fases donde el
código se escribe de verdad, en lugar de scripts descartables que habría que reescribir.

⚠️ **Costo asumido:** la coreografía de tres contenedores es la parte más novel del diseño y
recién se valida en la Fase 5, con más cosas construidas encima. Lo tolerable es que la Fase 3
ya construye el clonado y el volumen, así que hay señal temprana de la mitad riesgosa.

**Entregable:** ✅ [`docs/13-hallazgos-spike.md`](./13-hallazgos-spike.md) con las respuestas y
las correcciones aplicadas a los documentos (revisiones R3 y R4).

---

## Fase 1 — Esqueleto y persistencia ✅ CERRADA

- [x] Monorepo con workspaces: `apps/api`, `packages/contracts`. (`apps/web` llega en la Fase 2.)
- [x] Fastify con healthcheck, logging estructurado y manejo de errores uniforme.
- [x] Config por entorno validada con Zod al arrancar (si falta `MASTER_KEY`, no arranca).
- [x] **`packages/contracts`**: Zod del informe de [06](./06-agente-mantenimiento.md) + derivación
      del JSON Schema + prompt versionado. 50 tests.
- [x] **Cerrar I5** ✅: el schema (6.279 bytes) fue aceptado y el modelo devolvió un informe
      conforme. Ver [13](./13-hallazgos-spike.md). De paso quedaron cerradas I4 e I12.
- [x] Drizzle + better-sqlite3 con el DDL de [02](./02-modelo-de-datos.md) y primera migración.
- [x] Servicio de cifrado AES-256-GCM con AAD inequívoco + tests.

### Por qué `packages/contracts` se adelantó desde la Fase 5

**I5 es el único riesgo que queda con capacidad de cambiar el diseño.** El schema del doc 06 es
grande; si opencode lo rechaza o el modelo no lo respeta, hay que partir el trabajo del agente en
dos prompts, y eso reescribe el doc 06. Cuanto antes lo sepamos, menos se construye encima de un
supuesto.

🟢 No duplica trabajo: `packages/contracts` hay que escribirlo igual, y es un paquete puro sin
dependencias de la app. Con la credencial ya guardada en `spikes/.out/`, cerrar I5 es cuestión de
una tarde y **con código real**, no con un spike descartable.

**Entregable:** `npm run dev` levanta la API, crea la DB, responde `/api/health`, y sabemos si el
contrato del agente es viable tal como está escrito.

---

## Fase 2 — Autenticación ✅ CERRADA

- [x] OAuth de GitHub con Better Auth, `state`, PKCE y cookie firmada.
- [x] `users`, `sessions`, `accounts` y `verifications` en SQLite mediante Drizzle.
- [x] `GET /api/me` con estado de onboarding.
- [x] Web de login, sesión actual y logout.
- [x] Smoke test completo contra una OAuth App real de GitHub.

**Entregable:** se puede iniciar y cerrar sesión con GitHub.

---

## Fase 3 — GitHub App y repositorios 🟡 FUNCIONAL; I9/I10 DIFERIDOS

- [x] Documentar la configuración manual y los permisos de la GitHub App.
- [x] Flujo de instalación + callback `/api/github/setup`.
- [x] Token de instalación `metadata: read` con caché en memoria para listar repos.
- [x] `GET /api/github/available-repos`, `POST /api/repos`, `GET /api/repos`.
- [x] Smoke test completo contra una GitHub App real: instalación, listado y vinculación.
- [x] Configuración y conexión a Docker Desktop con Dockerode; estado visible en `/api/health`.
- [x] Token `contents: read` restringido por repo para clonado, sin caché ni persistencia.
- [x] Token restringido por repo para publicación (`contents: write`, `pull_requests: write`; Fase 7).
- [x] Imagen `manteiner-git` + `clone.sh`, con token por stdin/FIFO y limpieza del remote.
- [x] Chequeo de tamaño previo; volumen efímero; clon por Dockerode y limpieza en `finally`.
- [x] Sincronización on-demand al listar repos; webhooks diferidos para después de v1.

**Criterios de aceptación reubicados desde el spike 3:**

- [>] I10 — el token pasado por stdin **no** aparece en `docker inspect` ni en `/proc/<pid>/environ`.
      **Diferido:** verificar cuando el flujo completo ya sea funcional.
- [x] El volumen sobrevive entre contenedores secuenciales y no queda nada tras `docker volume rm`.
- [>] I9 — medir cuánto ocupa un clon `--depth 1` de repos reales, para calibrar `MAX_REPO_SIZE_KB`.
      **Diferido:** calibrar después de completar el flujo funcional.

**Entregable:** vincular un repo, clonarlo en un volumen efímero desde la API, y comprobar que
el repositorio no existe en ningún punto del filesystem del host.

---

## Fase 4 — Proveedores de IA ✅ CERRADA

Backend y UI implementados y verificados. Para catálogo y validación real se adelantó únicamente
la imagen base reproducible `manteiner-agent`; el runner y las auditorías siguen en Fase 5.

- [x] **Device flow de OpenAI**: iniciar, mostrar código, polling, intercambio PKCE, `accountId`.
- [x] Almacenamiento cifrado (`api` y `oauth`) + `GET`/`DELETE`.
- [x] Refrescar OAuth solo cerca del vencimiento, persistir antes de usar y marcar inválida si falla.
- [x] Catalog container + caché de `provider-catalog.json`.
- [x] `POST /api/providers` para API keys, con validación real contra el proveedor.
- [x] Selección de modelo (global y por repo), filtrando los que no soporten tool calling.
- [x] UI de onboarding (V2) y de configuración (V7), con la pantalla de "ingresá este código".
- [x] Caché del catálogo por proveedor con merge: entrar a Configuración ya no levanta contenedores.

**Entregable:** conectar la cuenta ChatGPT Plus por device code y elegir modelo.

---

## Fase 5 — Contenedor y agente (el corazón) ✅ IMPLEMENTADA CON UI

- [x] `docker/agent/Dockerfile` + build reproducible con versión pinneada de opencode. (Adelantado en Fase 4.)
- [x] `packages/agent-runner`: genera config, genera el agente, levanta `opencode serve`.
- [x] Orquestador: clonado + agente sobre el volumen, con todos los límites. El tercero (publish) es Fase 7.
- [x] Healthcheck con backoff exponencial, corte temprano si el contenedor muere, y timeouts.
- [x] `finally` que destruye contenedores y volumen en todos los caminos (incluido `SIGTERM` de la API).
- [x] Ejecución completa de una sesión con structured output y validación contra `packages/contracts`.
- [x] Limpieza garantizada (`finally`) y limpieza de huérfanos al arrancar, verificada contra Docker real.

**Criterios de aceptación reubicados desde la Fase 0 y el spike 3:**

- [x] I4 — `opencode serve` arranca sin credenciales y `auth.set` posterior funciona. Ver paso 1.3.
- [>] I6 — **decisión revisada:** se arranca con `bash: allow` y se restringe después, con los comandos que el agente pida de verdad. La contención real es el contenedor, no el permiso.
- [>] I7b — **neutralizada por diseño:** `run_steps` se deriva del array `steps` del informe validado, no de los eventos `todo.updated`. Un modelo indisciplinado degrada la barra de progreso, no el informe.
- [>] I11 — se mantiene el `git diff` por `exec`, con `snapshot: false`. Verificar el endpoint es barato y queda para el primer run real; no se cambia sin evidencia.
- [x] I12 — `auth.set` acepta `accountId` en opencode 1.18.30. Ver paso 1.3.
- [x] 3.5 — `dockerode` contra el named pipe de Docker Desktop en Windows. Cerrada por evidencia: clonado, catálogo, agente y limpieza corren por Dockerode sin configurar `DOCKER_SOCKET`.

**Entregable:** `POST /api/repos/:id/runs` corre el agente de punta a punta y guarda
`result_json`. ✅ Con el dashboard (V3), el informe (V5) y el histórico por repositorio.
El run responde 202; las Fases 6 y 7 ya agregaron SSE y publicación de PRs a este flujo.

---

## Fase 6 — Streaming SSE 🟡 FUNCIONAL

- [x] Traductor de eventos opencode → eventos de dominio, con `default` tolerante a tipos no declarados.
- [x] `run_events` + Event Bus con fan-out, que persiste antes de emitir.
- [x] `GET /api/runs/:id/events` con `Last-Event-ID`, replay, heartbeat y cierre al terminar.
- [x] Throttling de texto (500 ms / 400 caracteres), sin `reasoning`, payload de 8 KB y tope de 5.000 eventos por run.
- [x] Reconciliación de `run_steps` con el array `steps` del JSON final: los todos mueven la vista, el informe define el histórico.
- [x] UI de la vista en vivo (V4) y progreso real en las tarjetas del dashboard.

**Entregable:** se ve el progreso del agente en tiempo real y sobrevive a un F5. ✅ Falta
verificarlo contra un run real.

---

## Fase 7 — Pull Requests 🟡 IMPLEMENTADA; VERIFICACIÓN REAL PENDIENTE

- [x] `publish.sh` en la imagen `manteiner-git`: filtrado por allowlist, rama, commit, push.
- [x] Aserción dura del destino del push (`assertPushTarget`) + test que intente pushear a `main` y falle.
- [x] Lectura del diff por `exec` (a memoria) para el informe. (Ya estaba desde la Fase 5.)
- [x] `POST /pulls` desde el orquestador.
- [x] Manejo de casos borde: sin diff, rama existente, repo archivado, sin permisos.
- [x] Persistencia de `pr_number` / `pr_url` / `pr_branch` y evento `run.pr_created`.
- [x] UI: link al PR en el informe y chip `PR #n` en la tarjeta del repositorio.

Decisiones de implementación:

- 🟢 **`.git` no se considera confiable.** El agente corrió con `bash: allow` sobre ese mismo
  volumen, así que `publish.sh` reescribe `.git/config` (un `url.*.insteadOf` plantado desviaría
  el push con el token), desactiva hooks y `fsmonitor`, y hace `git reset` a la `base_sha` que
  devolvió el contenedor de clonado (no la del archivo del volumen). Si el agente commiteó por su
  cuenta, esos cambios vuelven al working tree y pasan igual por la allowlist.
- 🟢 El push usa `GIT_ASKPASS` + FIFO, igual que el clon: el token no aparece en la línea de
  comandos ni en `http.extraHeader`.
- 🟢 Un PR fallido **no** invalida la auditoría: queda en `result_json.pullRequest` con su motivo
  (`REPO_ARCHIVED`, `NO_ALLOWED_CHANGES`, `GITHUB_PERMISSION_MISSING`, `PR_BRANCH_EXISTS`…). La única
  excepción es `INVALID_PUSH_TARGET`, que indica un bug y tumba el run.
- 🟢 Si el push salió y falló el `POST /pulls`, se guarda la rama para poder abrir el PR a mano.

**Entregable:** una auditoría produce un PR real de actualizaciones de dependencias. Falta
verificarlo contra un repositorio real (requiere la GitHub App con `contents` y `pull_requests`
en Read & Write).

---

## Fase 8 — Reporte PDF e histórico 🔜 PRÓXIMA FEATURE

El histórico y la UI del informe ya existen (Fase 5). Lo que queda pendiente es el PDF.

- [ ] Plantilla con `@react-pdf/renderer` según [08](./08-reportes-pdf.md).
- [ ] `run_artifacts` + endpoint de descarga seguro.
- [ ] Regeneración del PDF.
- [x] UI del informe (tabs) y del histórico del repo. (Adelantada en la Fase 5.)

**Entregable:** exportación PDF completa. El cierre de v1 también requiere las verificaciones
pendientes de las Fases 3, 6, 7 y 9.

---

## Fase 9 — Endurecimiento 🟡 IMPLEMENTADO LO AUTOMATIZABLE

- [x] Rate limiting por usuario con `@fastify/rate-limit` (ver tabla abajo).
- [x] Límite de runs simultáneos con cola in-process (`MAX_CONCURRENT_RUNS=2`, `MAX_QUEUED_RUNS=10`).
- [x] Un solo run activo por repositorio (`409 RUN_ALREADY_ACTIVE`).
- [x] Sanitización del markdown en el frontend. (Ya estaba: `Markdown.tsx` arma elementos de React, nunca HTML.)
- [x] Redacción de secretos por patrón en logs y en `error_message` / `error_detail` persistidos.
- [x] Rotación de `MASTER_KEY`: `npm run rotate-master-key --workspace @manteiner/api`, transaccional e idempotente.
- [ ] Repo de prueba con prompt injection y verificación de contención. **Pendiente, manual.**
- [ ] Recorrer la checklist de [10](./10-seguridad.md). **Quedan los ítems de verificación manual.**

| Endpoint | Límite | Clave |
|---|---|---|
| `POST /api/repos/:id/runs` | 5 / hora | usuario |
| `POST /api/providers` y `POST /api/providers/oauth/:id/start` (comparten cupo) | 10 / 10 min | usuario |
| `POST /api/providers/catalog/refresh` | 3 / 10 min | usuario |
| `/api/auth/*` | 20 / min | IP |
| Resto de `/api/*` | 300 / min | usuario (IP si no hay sesión) |
| `GET /api/health` | sin límite | — |

Al exceder: `429 { error: { code: "RATE_LIMITED" } }` con `Retry-After`. Se apaga con
`RATE_LIMIT_ENABLED=false` (solo para depurar).

⚠️ El store del rate limit y la cola de runs viven en memoria del proceso: se reinician con la API.
Es coherente con el diseño de un solo proceso (doc 01); con varios procesos haría falta Redis.

Rotación de `MASTER_KEY`, con la API apagada:

1. `MASTER_KEY_PREVIOUS` = la clave actual; `MASTER_KEY` = una nueva; `MASTER_KEY_VERSION` + 1.
2. `npm run rotate-master-key --workspace @manteiner/api`.
3. Quitar `MASTER_KEY_PREVIOUS`. Si la clave anterior no descifra alguna fila, no se rota ninguna.

---

## Backlog (post-v1)

| Item | Nota |
|------|------|
| Auditoría de **seguridad** | Segundo `audit_type`; read-only total, sin PR. |
| Resto de proveedores **OAuth** (Claude Pro/Max, Copilot, xAI…) | ✅ El camino existe: `GET /provider/auth` + `POST /provider/{id}/oauth/{authorize,callback}`. Salen todos juntos, sin replicar flujos. Requiere un contenedor de opencode vivo durante el flujo. |
| Tendencia de hallazgos | `finding_key` a lo largo del tiempo. Requiere varios runs reales para validar estabilidad. |
| Auditorías programadas | Cron por repo. |
| Más ecosistemas | Python, Go, Rust: imágenes por ecosistema o imagen fat. |
| Proxy de egress con allowlist | Cierra el residual de exfiltración de T1. |
| Multi-usuario / organizaciones | Cambia el modelo de permisos. |
| Worker externo + cola persistente | Necesario para escalar más allá de un proceso. |

## Recordatorio de método

El objetivo declarado es **aprender construyendo paso a paso**. Por eso:

- Ninguna fase se implementa entera de una sin revisar la anterior.
- Antes de cada fase conviene releer el documento correspondiente y ajustarlo si algo cambió.
- Los hallazgos de la Fase 0 muy probablemente obliguen a corregir [04](./04-proveedores-ia-opencode.md) y [07](./07-progreso-sse.md). Eso es esperado, no un fracaso de la planificación.
