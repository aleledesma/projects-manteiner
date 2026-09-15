# 13 — Hallazgos de la Fase 0

Resultados de los spikes de verificación técnica. Cada hallazgo confirma, corrige o invalida
un supuesto de los documentos de diseño. **Cuando un hallazgo contradice un documento, se
corrige el documento y se anota acá qué cambió.**

Estado: 🔲 pendiente · ✅ confirmado · ❌ refutado · ⏭️ descartado

---

## Spike 1 — Device flow de OpenAI ✅

Script: [`spikes/src/01-openai-device-flow.ts`](../spikes/src/01-openai-device-flow.ts)
Fecha de ejecución: 2026-09-15
Cuenta de prueba: ChatGPT **Plus** (`chatgpt_plan_type: "plus"`)

| # | Pregunta | Estado | Resultado |
|---|----------|--------|-----------|
| 1.1 | ¿Funciona el device flow con una cuenta ChatGPT Plus? | ✅ | Sí, de punta a punta. Sin navegador en el servidor, sin callback local. |
| 1.2 | ¿Dónde está el `accountId`? | ✅ | `id_token` → claim `https://api.openai.com/auth` → **`chatgpt_account_id`** (UUID). Era la primera ruta candidata. |
| 1.3 | ¿Cuánto dura el access token? | ✅ | **864.000 s = 10 días.** Muchísimo más de lo previsto (se asumía ~1 h). |
| 1.4 | ¿Rota el refresh token al usarlo? | ✅ | **Sí, rota.** Cada refresh devuelve un `refresh_token` distinto. |
| 1.5 | ¿Aparece el `403` del token exchange? | ✅ | No. El intercambio PKCE funcionó a la primera. |

### Claims útiles del `id_token`

| Claim | Uso |
|-------|-----|
| `chatgpt_account_id` | El `accountId` que espera opencode. |
| `chatgpt_plan_type` | `"plus"`. Se puede mostrar el plan en la UI. |
| `chatgpt_subscription_active_until` | 🟡 **Permite avisar antes de que se venza la suscripción**, en vez de que falle un run. |
| `chatgpt_user_id`, `organizations[]` | Identidad y organizaciones de la cuenta. |
| `email`, `name` | Disponibles, pero **no los necesitamos**: la identidad ya viene del login de GitHub. No se almacenan. |

### Consecuencias — la combinación 1.3 + 1.4 invierte la estrategia

El plan del doc 04 era **refrescar proactivamente antes de cada run**, asumiendo un access token
de ~1 hora. Con los datos reales eso es innecesario y contraproducente:

- El access token dura **10 días**, mucho más que cualquier run (timeout: 30 min). Nunca se va a
  vencer a mitad de camino.
- Como el refresh **rota**, cada refresco es una oportunidad de perder la credencial.

🟢 **Regla corregida: refrescar lo menos posible.**

```ts
if (cred.expires_at < Date.now() + RUN_TIMEOUT_MS + MARGEN) {
  const nuevo = await refresh(cred.refresh);
  await db.updateCredential(nuevo);   // persistir ANTES de usarlo
}
```

En la práctica refresca **una vez cada ~10 días por usuario**, no una por run.

🟢 **Se eliminó la mitigación nº 2 del doc 04** (releer la credencial del contenedor). El plugin
solo refresca si `expires < Date.now()`, y la invariante de arriba garantiza lo contrario.

### Pregunta menor que quedó abierta

🔴 ¿El refresh viejo se invalida al instante o hay período de gracia? No bloquea: "persistir
primero" es correcto en ambos casos.

---

## Spike 2 — opencode SDK ✅ (análisis estático)

**Método: leer los tipos generados del SDK, no ejecutar nada.** El SDK se genera desde el
OpenAPI del servidor, así que `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` **es** la
especificación: endpoints, shapes y uniones discriminadas completas.

Mejor que un volcado en runtime: da el catálogo **entero**, no solo lo que llegó a dispararse en
una corrida; no gasta tokens; es reproducible.

Versión analizada: **`@opencode-ai/sdk@1.18.31`** · 67 endpoints · 3.383 líneas de tipos

| # | Pregunta | Estado | Resultado |
|---|----------|--------|-----------|
| 2.2 | ¿`auth.set` acepta `type: "oauth"` por HTTP? | ✅ | Sí. `/auth/{id}` con body `Auth` (unión de tres tipos). |
| 2.3 | Catálogo de eventos (I2) | ✅ | **32 tipos**, unión discriminada completa. |
| 2.4 | Forma de `config.providers()` (I3) | ✅ | `{ providers: Provider[], default: Record<string,string> }`. |
| 2.7 | ¿Endpoint HTTP que exponga `authorize()`? (I1b) | ✅ | **Sí, el flujo completo.** |
| 2.8 | ¿Se puede leer la credencial vigente? (I1c) | ❌ | **No.** No existe `AuthGet`. Ya no importa (spike 1). |
| 2.1 | ¿`serve` arranca sin credenciales? (I4) | 🔲 | Runtime. |
| 2.5 | Modelos habilitados por la cuenta Plus | ⏭️ | Descartada por ahora. |
| 2.6 | ¿Acepta el JSON Schema completo? (I5) | 🔲 | Runtime. |
| 2.9 | ¿Funciona con `bash: deny` + allowlist? (I6) | 🔲 | Runtime. |
| 2.10 | ¿Marcadores de paso confiables? (I7) | ✅ | **Resuelto de otra forma:** existe `todo.updated`. |

### 2.7 — El flujo OAuth está expuesto por HTTP (I1b)

```
GET  /provider/auth                   -> { [providerID]: ProviderAuthMethod[] }
POST /provider/{id}/oauth/authorize   body { method: <indice> }
                                      -> { url, method: "auto"|"code", instructions }
POST /provider/{id}/oauth/callback    body { method: <indice>, code?: string } -> boolean
```

```ts
type ProviderAuthMethod        = { type: "oauth" | "api"; label: string };
type ProviderAuthAuthorization = { url: string; method: "auto" | "code"; instructions: string };
```

**Consecuencia:** el resto de los proveedores OAuth (Claude Pro/Max, Copilot, xAI, GitLab Duo…)
**no requieren replicar el flujo de cada uno**. Alcanza con listar métodos, dejar que el usuario
elija uno, y pasarle `url` + `instructions` a la UI. Sale casi gratis en v2.

⚠️ Requiere **un servidor de opencode vivo durante todo el flujo**, porque el estado del PKCE
vive ahí.

### 2.3 — Catálogo real de eventos (I2)

Los 32 tipos de `Event`:

```
server.connected             session.created          pty.created
server.instance.disposed     session.updated          pty.updated
installation.updated         session.deleted          pty.exited
installation.updateAvailable session.status           pty.deleted
lsp.client.diagnostics       session.idle             tui.prompt.append
lsp.updated                  session.compacted        tui.command.execute
message.updated              session.diff             tui.toast.show
message.removed              session.error            command.executed
message.part.updated         file.edited              todo.updated
message.part.removed         file.watcher.updated     permission.updated
vcs.branch.updated           permission.replied
```

Payloads de los que nos importan:

```ts
{ type: "session.status";       properties: { sessionID, status } }
//   status = {type:"idle"} | {type:"busy"} | {type:"retry", attempt, message, next}
{ type: "session.idle";         properties: { sessionID } }
{ type: "session.error";        properties: { sessionID?, error? } }
//   error = ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError
{ type: "message.part.updated"; properties: { part: Part; delta?: string } }
{ type: "todo.updated";         properties: { sessionID; todos: Todo[] } }
{ type: "session.diff";         properties: { sessionID; diff: FileDiff[] } }
{ type: "file.edited";          properties: { file: string } }
{ type: "permission.updated";   properties: Permission }
```

```ts
type Part = TextPart | ReasoningPart | FilePart | ToolPart | StepStartPart | StepFinishPart
          | SnapshotPart | PatchPart | AgentPart | RetryPart | CompactionPart | subtask;

type ToolPart = { type: "tool"; callID; tool: string; state: ToolState; metadata? };
// ToolStateRunning   -> { status:"running",   input, title?, time:{start} }
// ToolStateCompleted -> { status:"completed", input, output, title, time:{start,end} }
```

🟢 `ToolStateRunning.title` es texto listo para mostrar: resuelve la línea "qué está haciendo
ahora" de la UI sin que inventemos descripciones.

🟢 `session.status` con `{type:"retry", attempt, message, next}` da visibilidad de los reintentos
del proveedor. No estaba contemplado y es justo lo que el usuario quiere ver cuando un run
parece congelado.

### 2.10 — `todo.updated` reemplaza los marcadores de texto (I7)

El doc 07 proponía que el agente emitiera marcadores tipo `[[step:dependency-research]]` en el
texto, y admitía que era frágil. **No hace falta:** opencode tiene lista de tareas nativa.

```ts
type Todo = { id: string; content: string; status: string; priority: string };
// status: pending | in_progress | completed | cancelled
```

- Evento `todo.updated` con el **array completo** en cada cambio.
- Endpoint `GET /session/{id}/todo` para leer el estado actual.

🟢 Estructurado, sin parsear prosa, y llega el array entero (no deltas), así que la UI se
sincroniza sin reconstruir estado.

⚠️ Sigue dependiendo de que el modelo mantenga la lista con disciplina — eso es runtime (I7b).
Pero el modo de falla pasa a ser "la lista queda desactualizada" en vez de "el parser se rompe".

### 2.4 — `Model` trae todo lo que la UI necesita (I3)

```ts
type Model = {
  id; providerID; name;
  capabilities: { toolcall: boolean; reasoning; temperature; attachment; input{...}; output{...} };
  cost:  { input; output; cache: { read; write } };
  limit: { context: number; output: number };
  status: "alpha" | "beta" | "deprecated" | "active";
};
```

🟢 `capabilities.toolcall` es exactamente el filtro que decidimos en A7.
🟢 `cost` permite estimar el gasto por run sin mantener tabla propia.
🟢 `status: "deprecated"` permite avisar sin una lista a mano.

### Endpoints útiles que no estaban en el diseño

| Endpoint | Para qué |
|----------|----------|
| `GET /session/{id}/diff` → `FileDiff[]` | `{ file, before, after, additions, deletions }`. 🔴 Podría reemplazar el `git diff` por `exec` del doc 05 — **pero** probablemente dependa de `snapshot`, que desactivamos. Verificar en runtime antes de cambiar nada. |
| `POST /session/{id}/prompt_async` | Prompt no bloqueante. Encaja mejor con streaming + timeout que el `prompt` bloqueante. |
| `GET /session/status` | Estado de todas las sesiones de una. |
| `GET /session/{id}/todo` | Lista de tareas actual (complementa el evento). |

### ⚠️ Discrepancia: `OAuth` sin `accountId`

El tipo del SDK 1.18.31 es:

```ts
type OAuth = { type: "oauth"; refresh: string; access: string; expires: number; enterpriseUrl?: string };
```

**No tiene `accountId`**, pero el código de la rama `dev` que leímos al planificar sí lo declara,
y el spike 1 lo extrajo correctamente del JWT. Es una diferencia de versión.

🟢 **Acción:** pinnear la versión de opencode en la imagen del agente y verificar en runtime que
`auth.set` acepta `accountId`. Si no, hay que comprobar si el plugin lo deriva solo del JWT del
access token — que es lo que hace `extractAccountId`, así que probablemente sí.

### Decisión sobre el flujo OAuth de OpenAI

| | Device flow propio (spike 1) | `/provider/{id}/oauth/authorize` |
|---|---|---|
| Requiere contenedor vivo | No | **Sí, durante todo el flujo** |
| Acoplado a constantes de OpenAI | Sí (`CLIENT_ID`, `ISSUER`) | No |
| Sirve para otros proveedores | No | **Sí, todos** |
| Verificado | ✅ funciona | 🔲 |

🟢 **Se mantiene el device flow propio para OpenAI en v1.** Ya está probado y no necesita
levantar un contenedor solo para autenticar.

🟡 **`/provider/{id}/oauth/authorize` es el camino para v2**, cuando agreguemos el resto de los
proveedores. Ahí sí conviene pagar el costo del contenedor efímero de autenticación — que
resulta que la idea original tenía razón en prever, solo que para los *otros* proveedores.

---

## Spike 3 — Coreografía de Docker ⏭️ SALTEADO

**No se ejecutó.** Sus preguntas se reubicaron como criterios de aceptación de las fases donde
el código se escribe de verdad.

**Razonamiento:** el criterio de la Fase 0 es *confirmar los supuestos que, si fallan, cambian la
arquitectura*. Las preguntas del spike 3 no califican: en su mayoría son comportamiento
documentado de Docker. La única con filo era I10, y un "no" cambiaría cómo pasamos el token al
contenedor de clonado, no el diseño.

| # | Pregunta | Reubicada en |
|---|----------|--------------|
| 3.1 / I10 | ¿El token por stdin queda fuera de `docker inspect`? | **Fase 3** |
| 3.2 | ¿Un volumen sobrevive entre contenedores secuenciales? | **Fase 3** |
| 3.3 / I9 | ¿Cuánto ocupa un clon `--depth 1`? | **Fase 3** (calibra `MAX_REPO_SIZE_KB`) |
| 3.4 | ¿Queda algo tras `docker volume rm`? | **Fase 3** |
| 3.5 | ¿`dockerode` contra el named pipe de Windows? | **Fase 5** |

⚠️ **Costo asumido:** la coreografía de tres contenedores es la parte más novel del diseño y
recién se valida en la Fase 5. Lo tolerable es que la Fase 3 ya construye el clonado y el
volumen, así que hay señal temprana de la mitad riesgosa.

---

## Paso 1.3 — Contrato contra opencode real ✅

Script: [`spikes/src/02-opencode-contract.ts`](../spikes/src/02-opencode-contract.ts)
Ejecutado el 2026-09-15 · opencode CLI **1.18.30** · modelo **gpt-5.6-sol** · schema **estricto**
57,6 s · 17.896 tokens (15.860 in / 1.863 out / 173 reasoning) · `cost: 0` (suscripción)

| # | Pregunta | Estado | Resultado |
|---|----------|--------|-----------|
| I4 | ¿`opencode serve` arranca sin credenciales? | ✅ | **Sí.** Responde antes de cualquier `auth.set`. Confirma la opción (2) del doc 04. |
| I12 | ¿`auth.set` acepta `accountId`? | ✅ | **Sí** en opencode 1.18.30. |
| I5a | ¿opencode acepta el JSON Schema completo? | ✅ | **Sí.** 6.279 bytes, variante estricta, aceptado sin queja. |
| I5b | ¿El modelo lo respeta? | ✅ | **Sí.** Devolvió un informe conforme al contrato. |
| I7b | ¿El modelo mantiene la lista de todos? | ⏸️ | **Sin evidencia.** El prompt sintético pedía explícitamente no usar herramientas, así que no hubo `todo.updated`. Se mide en la Fase 5. |

🟢 **I5 cerrado: el contrato del agente es viable tal como está escrito.** Era el último riesgo
con capacidad de cambiar el diseño. No hay que partir el trabajo en dos prompts.

### ⚠️ El campo es `structured`, NO `structured_output`

La documentación de opencode dice:

```js
const report = result.data.info.structured_output   // ← NO existe
```

El campo real en la respuesta es **`info.structured`**:

```jsonc
{
  "info": {
    "modelID": "gpt-5.6-sol",
    "providerID": "openai",
    "finish": "tool-calls",
    "cost": 0,
    "tokens": { "total": 17896, "input": 15860, "output": 1863, "reasoning": 173 },
    "structured": { "schema_version": "1.0", "audit_type": "maintenance", ... }
  }
}
```

⚠️ Esto causó un **falso negativo** en la primera corrida: el script buscaba
`structured_output`, no lo encontraba, y reportó "I5 EN RIESGO" cuando en realidad había
funcionado. Corregido en el script con fallback a ambos nombres por si cambia entre versiones.

🟡 `finish: "tool-calls"` en un prompt que pedía explícitamente no usar herramientas sugiere que
**structured output está implementado como una tool call por debajo**. Es una hipótesis, no un
hecho verificado, pero explicaría el valor.

🟡 `cost: 0` — con autenticación por suscripción no se reporta costo por token. La estimación de
gasto por run del doc 09 no va a funcionar por esta vía; solo servirá para proveedores con API
key. Anotar en la UI.

### ⚠️ El runtime emite MÁS eventos de los que declaran los tipos del SDK

Esto **corrige una afirmación mía del spike 2**. Dije que los tipos generados del SDK "son la
especificación". Son un catálogo útil y necesario, pero **no completo**: el servidor real emite
tipos que no están en la unión `Event` de `@opencode-ai/sdk@1.18.31`.

Eventos observados en una corrida real:

| Evento | Veces | ¿Está en los tipos del SDK? |
|--------|-------|------------------------------|
| `plugin.added` | 45 | ❌ **no** |
| `message.part.updated` | 10 | ✅ sí |
| `server.heartbeat` | 5 | ❌ **no** |
| `message.updated` | 4 | ✅ sí |
| `session.updated` | 3 | ✅ sí |
| `session.status` | 2 | ✅ sí |
| `tui.toast.show` | 2 | ✅ sí |
| `catalog.updated` | 2 | ❌ **no** |
| `message.part.delta` | 2 | ❌ **no** |
| `server.connected` | 1 | ✅ sí |
| `session.diff` | 1 | ✅ sí |
| `reference.updated` | 1 | ❌ **no** |
| `integration.updated` | 1 | ❌ **no** |

Consecuencias para [07](./07-progreso-sse.md):

- 🟢 **El `default` del `switch` del traductor no es opcional, es obligatorio.** Hay tipos que no
  existen en la unión, así que TypeScript no va a avisar de nada y el código tiene que tolerarlos.
- 🟢 **`message.part.delta` hay que manejarlo.** Es un evento aparte de `message.part.updated` y
  el doc 07 no lo contemplaba. Probablemente sea el que trae los deltas de texto para el throttle.
- 🟢 **`server.heartbeat` sirve como señal de vida del contenedor**, mejor que inventar la nuestra.
- 🟢 **`plugin.added` es ruido puro** (45 de 79 eventos, el 57%). Va a la lista de ignorados.
- 🟡 `catalog.updated`, `reference.updated`, `integration.updated`: sin documentar. Ignorar por ahora.

⚠️ **Nota de versión:** el CLI instalado es 1.18.30 y los tipos analizados son del SDK 1.18.31.
Parte de la diferencia puede venir de ahí. La conclusión de método se mantiene igual: **los tipos
sirven para descubrir el catálogo, pero hay que confirmarlo con una corrida real.**

### Ausencias esperables

No aparecieron `todo.updated`, `file.edited` ni `permission.updated`. Es coherente con el prompt
sintético, que pedía no usar herramientas. **No dice nada sobre I6 ni I7b**: esas se miden en la
Fase 5 con el prompt real y el agente `maintainer`.

Ojo también: la corrida usó el agente `build` por defecto (`"mode": "build"`, `"agent": "build"`),
no nuestro agente `maintainer`, que todavía no existe como archivo.

---

## Runtime pendiente (I4, I5, I6, I7b)

Lo que **no** se puede saber leyendo tipos, porque es comportamiento del servidor o del modelo:

| # | Pregunta | Cuándo verificarlo |
|---|----------|--------------------|
| I4 | ¿`opencode serve` arranca sin credenciales cargadas? | Spike 3 o Fase 5. |
| I5 | ¿Acepta y respeta el JSON Schema completo del informe? | **Fase 1** (contrato adelantado). Señal temprana: el schema derivado pesa **6.279 bytes**, lejos de cualquier límite razonable. Falta probarlo contra opencode. |
| I6 | ¿El agente trabaja con `bash: deny` + allowlist, o se traba? | Fase 5, primer run real. |
| I7b | ¿El modelo mantiene la lista de todos con disciplina? | Fase 5, primer run real. |

🟢 Ninguna bloquea las fases 1 a 4. Se verifican todas juntas en el primer run real, que es
cuando hay con qué probarlas.
