# 12 — Decisiones tomadas y decisiones abiertas

## Decisiones tomadas 🟢

Estas se dan por firmes salvo que las cambiemos explícitamente.

| # | Decisión | Fundamento |
|---|----------|-----------|
| D1 | **SQLite** (better-sqlite3 + Drizzle, WAL) | Pedido explícito: simplicidad y velocidad. |
| D2 | **GitHub App** para acceso a repos, OAuth solo para login | Permisos por repo, tokens de 1h, revocable. Un OAuth App con scope `repo` da acceso total y permanente. |
| D3 | `contents: write` + `pull_requests: write` | No existe "solo lectura + PRs" en GitHub: crear la rama exige escritura. Se compensa con D4 y el prefijo de rama forzado. |
| D4 | ~~El clon lo hace el host~~ → **revisada, ver D4bis** | — |
| D4bis | **Tres contenedores secuenciales sobre un volumen efímero compartido** | Satisface a la vez las dos restricciones: el token nunca convive con el LLM, y el repositorio nunca vive en el filesystem de la aplicación. Ver R1. |
| D4ter | El volumen es un **volumen local de Docker** (disco virtual), no tmpfs | Un tmpfs consumiría RAM proporcional al tamaño del repo. Ver R1b. |
| D5 | El orquestador dirige la sesión de opencode; el runner solo expone el servidor | Prompt, schema y reintentos viven en el host, versionados y testeables. |
| D6 | **Structured output** con JSON Schema derivado de Zod | Una sola fuente de verdad para restringir al modelo y validar en el host. |
| D7 | `edit` y `bash` en **deny por defecto** con allowlist | El agente solo puede tocar manifiestos y correr comandos de consulta. |
| D8 | Validación del diff en el **contenedor de publicación sin LLM** antes del PR | Defensa en profundidad sin sacar el repositorio del volumen: los permisos son config, esto es código nuestro. |
| D9 | Persistir eventos **antes** de emitirlos por SSE | El histórico no puede depender de que haya un navegador conectado. |
| D10 | `run_events.id` autoincremental como cursor de `Last-Event-ID` | Es el único modo de hacer replay al reconectar. |
| D11 | `provider_id`, `model_id`, `agent_version`, `schema_version` **congelados** en cada run | Sin eso el histórico deja de ser interpretable. |
| D12 | PDF generado **en el host**, no en el contenedor | Regenerable sin gastar tokens; contenedor más chico. |
| D13 | ~~v1 sin proveedores OAuth~~ → **revisada, ver D13bis**. v1 sigue **sin** auditoría de seguridad. | — |
| D13bis | **v1 soporta OpenAI por OAuth (device code), implementado en nuestra API** | Es el proveedor que hace falta para probar. La investigación confirmó que `auth.set` acepta `type: "oauth"` y que opencode tiene un flujo device code headless cuyas constantes y endpoints son públicos. **No hace falta ningún contenedor de autenticación.** |
| D14 | Un solo run activo por repositorio | Evita PRs duplicados y carreras sobre el workspace. |
| D15 | Cifrado AES-256-GCM con AAD = `JSON.stringify([userId, providerId])` | Impide reutilizar un ciphertext movido entre usuarios sin colisiones por delimitadores. |
| D16 | El token de GitHub viaja por **stdin**, no por variable de entorno | Las env vars quedan en `docker inspect` y en `/proc/<pid>/environ`; stdin se consume y no persiste. |
| D17 | El push a la rama principal se impide por **invariante de código**, no por GitHub | El token tiene `contents: write`: GitHub no lo impediría. Lo impiden el nombre de rama computado, el punto único de escritura y una aserción dura. |
| D18 | `STORE_PATCH_ARTIFACT=false` por defecto | El PR es el registro canónico del diff; guardarlo además duplicaría código del usuario en nuestro disco. |
| D19 | **Better Auth 1.6** para login y sesiones | Reduce lógica criptográfica propia, integra GitHub + Drizzle/SQLite y mantiene la GitHub App separada. Los hooks descartan los tokens OAuth antes de persistir. |

---

## Revisiones registradas

### R7 — Better Auth reemplaza la autenticación propia

**Planteo previo:** implementar manualmente `state`, PKCE, callback, cookies, tokens de sesión,
expiración y logout.

**Resolución:** Better Auth administra el protocolo OAuth y las tablas `users`, `sessions`,
`accounts` y `verifications`. Fastify solo adapta Request/Response y expone `/api/me`.

**Límite:** esto no reemplaza la GitHub App de la Fase 3. Además, como el token OAuth de login
solo sirve para identificar al usuario, hooks lo reemplazan por `NULL` antes de cada escritura
de `accounts`.

### R1 — El workspace no puede tocar el disco del host

**Planteo original (rechazado):** el host clona en `data/workspaces/<runId>` y lo borra al terminar.

**Objeción:** "no contemples la opción de clonarlo en la máquina y luego eliminarlo, debe ser
efímero". Un borrado posterior no es lo mismo que no haber escrito nunca: quedan rastros
recuperables, ventanas de tiempo en que el código está en disco, y dependencia de que el
borrado efectivamente ocurra.

**Tensión a resolver:** un solo contenedor no puede satisfacer las dos restricciones. Si el
contenedor clona, tiene el token (y el agente podría exfiltrarlo). Si el host clona, el repo
toca el host.

**Resolución:** separar **en el tiempo**, no en el espacio. Tres contenedores secuenciales
comparten un volumen efímero de Docker; solo el primero y el tercero ven el token, y ninguno
de los dos ejecuta un LLM. Detalle completo en [05](./05-ejecucion-en-docker.md).

**Beneficio lateral no previsto:** desaparece el problema de rendimiento de los bind mounts de
Docker Desktop en Windows, porque el volumen vive dentro de la VM de Linux.

### R1b — El volumen va en disco de Docker, no en RAM

**Planteo previo (corregido):** el volumen compartido respaldado en **tmpfs**, es decir en RAM,
para garantizar que el repositorio no tocara ningún disco en ningún momento.

**Objeción:** es probable que se auditen repositorios grandes, y aun sin llegar al tope del
volumen, el consumo de RAM es alto. Con `MAX_CONCURRENT_RUNS × WORKSPACE_SIZE` el costo escala
mal y compite con la memoria que necesita el propio contenedor del agente.

**Resolución:** el default pasa a ser un **volumen local de Docker** en su disco virtual
(`WORKSPACE_BACKEND=disk`). `tmpfs` queda como opt-in documentado.

**Por qué sigue cumpliendo el requisito original:** el repositorio nunca aparece en el árbol
del proyecto ni en ninguna ruta que maneje la app; el proceso de la API no puede leerlo (vive
dentro de la VM de Docker); y se destruye atómicamente con `docker volume rm`, sin depender de
un `rm -rf` que podría fallar. La diferencia con el planteo rechazado en R1 se mantiene intacta.

**Lo que se pierde, y por qué se acepta:** al escribirse en disco, tras `docker volume rm` los
bloques quedan desasignados pero no sobreescritos, así que en teoría son recuperables con
forense sobre el disco virtual. Se acepta porque quien tenga ese nivel de acceso al host ya
dispone de la base SQLite y de la `MASTER_KEY` del entorno: el riesgo marginal es bajo.

**Lo que hay que compensar:** los volúmenes locales de Docker **no soportan límite de tamaño**,
así que desaparece el tope duro que daba el `size=` del tmpfs. Se reemplaza por un chequeo
previo barato contra `repo.size` de la API de GitHub (`MAX_REPO_SIZE_KB`), que además falla más
temprano y con mejor mensaje que un `ENOSPC` a mitad del clon.

⚠️ **Nota operativa:** el `ext4.vhdx` de WSL2 crece hasta el pico histórico de uso y no se
achica solo aunque se borre cada volumen. Conviene compactarlo periódicamente.

**Nota:** la primera versión de esta resolución usaba un volumen tmpfs (RAM). Se corrigió
en R1b.

### R2 — OAuth de proveedores entra en v1

**Planteo original (rechazado):** v1 solo con proveedores por API key; OAuth a v2.

**Objeción:** el proveedor disponible para probar es OpenAI con cuenta ChatGPT Plus, que es
justamente OAuth.

**Lo que cambió:** era una decisión tomada sobre una suposición ("`opencode auth login` es
interactivo, así que no se puede automatizar") en vez de sobre el código. Al mirar el código:

- `Auth.Info` es la unión `Oauth | Api | WellKnown`, y `set()` acepta las tres. `auth.set`
  **sí** recibe `type: "oauth"`.
- opencode ya trae un método `ChatGPT Pro/Plus (headless)` con flujo **device code**, pensado
  exactamente para servidores y contenedores, con endpoints y `client_id` públicos.

**Resolución:** implementamos el device flow en nuestra API. Ver [04](./04-proveedores-ia-opencode.md).

**Consecuencia de alcance:** el "contenedor efímero para el flujo de auth" que preveía la idea
original **ya no existe**. El flujo es HTTP puro desde la API.

**Riesgo nuevo que aparece:** la rotación del refresh token. El plugin refresca dentro del
contenedor y persiste ahí; ese contenedor se destruye. La mitigación que se planteó acá quedó
**corregida por R3**, una vez que el spike 1 midió los valores reales.

### R3 — El access token dura 10 días y el refresh rota (spike 1)

**Planteo previo (corregido):** refrescar el token OAuth proactivamente antes de cada run,
asumiendo un access token de ~1 hora, y releer la credencial del contenedor antes de destruirlo
por si el plugin la había rotado adentro.

**Lo que midió el spike 1:** el access token dura **864.000 s (10 días)** y el refresh token
**rota en cada uso**.

**Resolución — la combinación invierte la estrategia:**

- Refrescar **lo menos posible**, no lo más posible. Regla:
  `if (expires_at < now + RUN_TIMEOUT_MS + margen) refresh()`. En la práctica, una vez cada
  ~10 días por usuario en lugar de una por run.
- **Se elimina la relectura de la credencial del contenedor.** El plugin solo refresca si
  `expires < Date.now()`, y la regla de arriba garantiza lo contrario durante todo el run. Una
  llamada HTTP menos y menos código.
- El refresco queda como **sección crítica**: persistir el par nuevo en una transacción antes de
  usarlo; si falla, marcar la credencial `invalid`.

**Por qué importaba:** con un refresh que rota, refrescar de más no es gratis — cada refresco es
una oportunidad de perder la credencial del usuario.

### R4 — `todo.updated` reemplaza el parseo de marcadores (spike 2)

**Planteo previo (corregido):** detectar los pasos del agente pidiéndole que emitiera marcadores
tipo `[[step:dependency-research]]` en el texto, y parsearlos. El propio documento admitía que
era frágil.

**Lo que encontró el spike 2:** opencode tiene **lista de tareas nativa**. Evento `todo.updated`
con el array completo en cada cambio, más `GET /session/{id}/todo`.

**Resolución:** el prompt le pide al agente crear las 7 fases como todos literales. El traductor
las mapea por posición y texto normalizado. La fuente autoritativa del histórico sigue siendo el
array `steps` del JSON final.

**Por qué es mejor:** estructurado en vez de prosa; llega el array entero, así que `steps.updated`
es idempotente y un replay parcial no corrompe la vista. El modo de falla pasa de "el parser se
rompe" a "la lista queda desactualizada".

**Método que vale recordar:** el usuario propuso resolver el spike 2 leyendo los tipos generados
del SDK en lugar de ejecutar nada. Funcionó mejor que un volcado en runtime: el SDK se genera
desde el OpenAPI, así que los tipos **son** la especificación, y dan el catálogo entero en vez de
solo lo que llegó a dispararse en una corrida.

### R5 — Fase 0 cerrada: spike 3 salteado, `contracts` adelantado

**Planteo previo:** un tercer spike para verificar la coreografía de Docker.

**Objeción:** aplicando el criterio de la propia Fase 0 —*confirmar los supuestos que, si fallan,
cambian la arquitectura*— el spike 3 no califica. Sus preguntas son en su mayoría comportamiento
documentado de Docker; la única con filo (I10, el token por stdin) cambiaría cómo pasamos el
token, no el diseño.

**Resolución:**

- Spike 3 **salteado**; sus preguntas pasan a **criterios de aceptación** de las fases 3 y 5,
  donde el código se escribe de verdad en lugar de en scripts descartables.
- **`packages/contracts` se adelanta de la Fase 5 a la Fase 1**, porque **I5 es el único riesgo
  que queda con capacidad de cambiar el diseño**: si opencode no acepta o no respeta el JSON
  Schema completo del informe, hay que partir el trabajo del agente en dos prompts y reescribir
  el doc 06.

**Costo asumido:** la coreografía de tres contenedores recién se valida en la Fase 5, con más
cosas construidas encima. Tolerable porque la Fase 3 ya construye el clonado y el volumen, así
que hay señal temprana de la mitad riesgosa.

---

## Decisiones abiertas 🟡 — necesitan tu confirmación

### ~~A1 — Framework~~ ✅ resuelta

**Fastify + React/Vite**, monorepo, **TypeScript en ambos lados**.

Routing del frontend: **React Router en modo declarativo** — es lo más rápido de montar y lo
más popular del ecosistema, con diferencia. El paquete es `react-router` (desde v7 ya no
`react-router-dom`) y el setup mínimo es envolver la app en `<BrowserRouter>`:

```tsx
import { BrowserRouter, Routes, Route } from "react-router";

<BrowserRouter>
  <Routes>
    <Route element={<AppLayout />}>
      <Route index element={<Dashboard />} />
      <Route path="repos/:repoId" element={<RepoDetail />} />
      <Route path="runs/:runId" element={<RunView />} />
      <Route path="settings" element={<Settings />} />
    </Route>
    <Route path="login" element={<Login />} />
  </Routes>
</BrowserRouter>
```

🟢 Modo declarativo, no "framework mode": no queremos SSR ni loaders. El estado vive en el
backend y se busca con fetch; el router solo mapea URLs a componentes.

🟡 Se descartó TanStack Router: mejor inferencia de tipos en params, pero más configuración y
mucha menos gente que lo conoce. No compensa acá.

### ~~A2 — Entrega de la credencial al contenedor~~ ✅ resuelta

**`client.auth.set()` por HTTP.** Ya no es solo la opción más segura: es la única que sirve
para credenciales OAuth, que no se pueden expresar como `{env:VAR}` en `opencode.json`. Sigue
pendiente confirmar en la Fase 0 que `opencode serve` arranca sin credenciales cargadas (I4).

### ~~A3 — Creación del PR: ¿`git push` o API de Git de GitHub?~~ ✅ resuelta

**`git push` desde el contenedor de publicación.** La API de blobs/trees/commits existía para
controlar qué archivos entran al commit, pero ese filtro ya se aplica sobre el working tree
antes de commitear; y usar la API obligaría a sacar el contenido de los archivos del volumen
hacia el host, que es justo lo que R1 evita.

### ~~A4 — Librería de PDF~~ ✅ resuelta

**`@react-pdf/renderer`.** Sin Chromium en el servidor. Hay que versionar los `.ttf` de las
fuentes en el repo para que el build sea reproducible ([08](./08-reportes-pdf.md)).

### A5 — Webhooks de GitHub en v1, ¿sí o no?

**Recomendación: sí, pero mínimos** (`installation.deleted`, `installation_repositories.*`).
Sin ellos, si el usuario revoca desde GitHub la app queda con estado obsoleto y los runs
fallan con errores confusos. La alternativa es re-sincronizar en cada carga del dashboard:
más simple, más llamadas a la API, más latencia.

### ~~A6 — Alcance de ecosistemas~~ ✅ resuelta

**Solo Node/JS/TS en v1.** La imagen del agente no lleva Python, Go ni Rust, y las reglas de
actualización de dependencias se escriben para npm/pnpm/yarn.

Consecuencia a manejar en el producto: si el usuario vincula un repo de otro ecosistema, el
agente debe **detectarlo en `repo-discovery` y terminar con un informe honesto** ("no puedo
auditar este stack todavía"), no producir hallazgos inventados. Es un caso de `skipped`
legítimo, no un fallo del run.

### ~~A7 — Temperatura y modelo~~ ✅ resuelta

**`temperature: 0.1`.** Consistencia por sobre creatividad.

**El modelo lo elige el usuario, sin recomendación de la app.** No se marca ninguno como
"recomendado" ni se ordena la lista por calidad: si elige uno pobre, el resultado pobre es su
responsabilidad.

⚠️ Una excepción que conviene distinguir: **sí se excluyen de la lista los modelos que no
soportan tool calling**. No es un juicio de calidad — el agente necesita leer archivos y correr
comandos, así que con esos modelos el run falla el 100% de las veces. Es filtrar lo que no
funciona, no opinar sobre lo que funciona mejor. 🟡 Si preferís mostrarlos igual y dejar que el
run falle, se cambia con una línea.

---

## Preguntas a investigar 🔴 — Fase 0

Ninguna bloquea la planificación, pero todas condicionan detalles de implementación.

| # | Pregunta | Impacto si la respuesta es "no" |
|---|----------|--------------------------------|
| ~~I1~~ | ~~¿`POST /auth/{id}` acepta `type: "oauth"`?~~ | ✅ **Resuelto: sí.** `Auth.Info = Oauth \| Api \| WellKnown`. Ver R2. |
| ~~I1b~~ | ~~¿Endpoint HTTP que exponga `authorize()`?~~ | ✅ **Sí:** `GET /provider/auth` + `POST /provider/{id}/oauth/{authorize,callback}`. Habilita todos los proveedores OAuth en v2 sin replicar flujos. |
| ~~I1c~~ | ~~¿Se puede leer la credencial vigente por HTTP?~~ | ❌ **No existe `AuthGet`.** Irrelevante: el spike 1 eliminó la necesidad. |
| ~~I1d~~ | ~~¿Qué modelos habilita OpenAI por suscripción?~~ | ⏭️ Descartada por ahora a pedido del usuario. |
| ~~I2~~ | ~~Catálogo de eventos de `event.subscribe()`~~ | ✅ **32 tipos**, con payloads exactos. El doc 07 se reescribió con datos reales. |
| ~~I3~~ | ~~¿Qué campos trae `config.providers()`?~~ | ✅ `{ providers: Provider[], default }`. `Model.capabilities.toolcall`, `cost`, `limit`, `status`. |
| ~~I4~~ | ~~¿`opencode serve` arranca sin credenciales?~~ | ✅ **Resuelto: sí.** Confirma A2 (entregar la credencial por `auth.set`). |
| ~~I5~~ | ~~¿Acepta y respeta opencode el JSON Schema completo?~~ | ✅ **Resuelto: sí.** 6.279 bytes aceptados, informe conforme al contrato. No hay que partir el trabajo en dos prompts. Ver [13](./13-hallazgos-spike.md). |
| I6 | ¿Cómo se comporta el agente con `bash: deny` + allowlist? | Si queda bloqueado, hay que aflojar la allowlist o cambiar de enfoque. |
| ~~I7~~ | ~~¿Puede el agente emitir marcadores de paso confiables?~~ | ✅ **Disuelta:** opencode tiene lista de tareas nativa (`todo.updated` + `GET /session/{id}/todo`). No hay que parsear texto. |
| I7b | ¿El modelo mantiene la lista de todos con disciplina? | Reemplaza a I7. Si no, la UI en vivo queda desactualizada — pero el histórico sale igual del JSON final. Degradación aceptable. |
| I11 | ¿`GET /session/{id}/diff` funciona con `snapshot: false`? | Si funciona, reemplaza el `git diff` por `exec` del doc 05 y simplifica la recolección. |
| ~~I12~~ | ~~¿`auth.set` acepta `accountId`?~~ | ✅ **Resuelto: sí** en opencode 1.18.30, aunque el SDK 1.18.31 no lo declare en los tipos. |
| I13 | ¿Qué son `catalog.updated`, `reference.updated`, `integration.updated`? | Eventos observados en runtime que no están en los tipos del SDK ni documentados. Por ahora se ignoran. |
| ~~I8~~ | ~~Rendimiento de bind mounts en Docker Desktop/Windows~~ | ✅ **Disuelta por R1:** ya no hay bind mounts; el volumen vive dentro de la VM de Linux. |
| I9 | ¿Cuánto ocupa clonar repos típicos con `--depth 1`? | Calibra `MAX_REPO_SIZE_KB`. → **criterio de aceptación de la Fase 3**. |
| I10 | ¿El token por stdin queda fuera de `docker inspect` y de `/proc/<pid>/environ`? | Supuesto de D16. → **criterio de aceptación de la Fase 3**. |

---

## Cosas que quedaron fuera a propósito

Para que no se lean como olvidos:

- **Tests del agente.** Evaluar la calidad de salida de un LLM requiere un set de repos de
  referencia y criterios de evaluación. Es un proyecto en sí mismo; se encara cuando el flujo
  funcione.
- **Internacionalización.** La app y los informes se escriben en español. El prompt le pide al
  agente responder en español.
- **Observabilidad.** Logging estructurado desde el inicio; métricas y trazas cuando haya
  usuarios.
- **Despliegue.** v1 apunta a correr en una sola máquina con Docker. El empaquetado y el
  hosting se deciden cuando haya algo que desplegar.
