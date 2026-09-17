# 11 — Roadmap de implementación

El orden está pensado para que **cada fase termine en algo que se pueda ejecutar y ver
funcionando**, y para atacar primero el riesgo técnico más alto. No se construye la UI
bonita antes de saber si el agente dentro del contenedor funciona.

Cada fase es una conversación aparte: "construyamos la fase N".

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
- [ ] Token restringido por repo para publicación (se implementa junto con los PR en Fase 7).
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

## Fase 5 — Contenedor y agente (el corazón) 🟡 BACKEND COMPLETO

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
`result_json`. Sin streaming ni PR todavía. ✅ Con el dashboard (V3), el informe (V5) y el
histórico por repositorio; el run responde 202 y la UI sigue el estado por polling hasta que
la Fase 6 traiga el SSE.

---

## Fase 6 — Streaming SSE

- [ ] Traductor de eventos opencode → eventos de dominio (con el catálogo real de la Fase 0).
- [ ] `run_events` + Event Bus con fan-out.
- [ ] `GET /api/runs/:id/events` con `Last-Event-ID`, replay y heartbeat.
- [ ] Throttling y topes de volumen.
- [ ] Reconciliación de `run_steps` con el array `steps` del JSON final.
- [ ] UI de la vista en vivo.

**Entregable:** se ve el progreso del agente en tiempo real y sobrevive a un F5.

---

## Fase 7 — Pull Requests

- [ ] `publish.sh` en la imagen `manteiner-git`: filtrado por allowlist, rama, commit, push.
- [ ] Aserción dura del destino del push (`assertPushTarget`) + test que intente pushear a `main` y falle.
- [ ] Lectura del diff por `exec` (a memoria) para el informe.
- [ ] `POST /pulls` desde el orquestador.
- [ ] Manejo de casos borde: sin diff, rama existente, repo archivado, sin permisos.
- [ ] Persistencia de `pr_number` / `pr_url` y evento `run.pr_created`.

**Entregable:** una auditoría produce un PR real de actualizaciones de dependencias.

---

## Fase 8 — Reporte PDF e histórico

- [ ] Plantilla con `@react-pdf/renderer` según [08](./08-reportes-pdf.md).
- [ ] `run_artifacts` + endpoint de descarga seguro.
- [ ] Regeneración del PDF.
- [ ] UI del informe (tabs) y del histórico del repo.

**Entregable:** v1 completa.

---

## Fase 9 — Endurecimiento

- [ ] Rate limiting.
- [ ] Sanitización del markdown en el frontend.
- [ ] Redacción de secretos en logs.
- [ ] Repo de prueba con prompt injection y verificación de contención.
- [ ] Rotación de `MASTER_KEY`.
- [ ] Recorrer la checklist de [10](./10-seguridad.md).

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
