# 07 — Progreso en tiempo real (SSE)

> **Revisión 2.** La v1 de este documento mapeaba eventos de opencode *supuestos* y proponía
> detectar los pasos parseando marcadores de texto. El spike 2 dio el catálogo real de eventos
> y apareció `todo.updated`, que hace innecesario el parseo. Ver [13](./13-hallazgos-spike.md).

## El problema

Un run dura entre varios minutos y media hora. El usuario necesita ver que algo pasa, y la app
necesita registrar qué pasó. Son dos requisitos distintos que se resuelven con la misma
tubería: **todo evento se persiste primero y se emite después**.

## Arquitectura de dos saltos

```
  Contenedor                    API (host)                         Navegador
+-------------+          +----------------------+          +------------------+
| opencode    |  SSE     |  EventTranslator     |          |                  |
| GET /event  |=========>|  opencode -> dominio |          |                  |
+-------------+  (SDK)   +----------+-----------+          |                  |
                                    |                      |                  |
                              +-----v------+               |                  |
                              |  SQLite    |  persistir    |                  |
                              | run_events |  PRIMERO      |                  |
                              +-----+------+               |                  |
                                    |                      |                  |
                              +-----v------+   SSE         |  EventSource     |
                              | Event Bus  |==============>|  /runs/:id/events|
                              | (fan-out)  |               |                  |
                              +------------+               +------------------+
```

🟢 **Persistir antes de emitir** es la regla. Si el navegador no está conectado, o se desconecta,
el evento igual quedó. La UI en vivo es una vista del log, no la fuente.

## Salto 1: consumir eventos de opencode

```ts
const events = await client.event.subscribe();
for await (const event of events.stream) {
  await translator.handle(runId, event); // event.type, event.properties
}
```

### Catálogo real — ✅ tipos del SDK **+** corrida real

`Event` es una unión discriminada de **32 tipos** en `@opencode-ai/sdk@1.18.31`.

⚠️ **Pero el runtime emite más tipos de los que la unión declara.** En una corrida real contra
opencode 1.18.30 aparecieron seis eventos que no están en los tipos: `plugin.added`,
`server.heartbeat`, `catalog.updated`, `message.part.delta`, `reference.updated` e
`integration.updated`. Ver [13](./13-hallazgos-spike.md).

🟢 **Consecuencia de diseño: el `default` del `switch` no es una cortesía, es obligatorio.**
TypeScript no puede avisarnos de tipos que no existen en la unión, así que el traductor tiene
que tolerar lo desconocido sin romperse.

Los que nos interesan, con su payload exacto:

| Evento opencode | Payload | Evento de dominio |
|---|---|---|
| `server.connected` | `{}` | `run.connected` |
| `session.status` | `{ sessionID, status }` | `run.status_changed` / `agent.retrying` |
| `session.idle` | `{ sessionID }` | `run.agent_finished` |
| `session.error` | `{ sessionID?, error? }` | `run.error` |
| `message.part.updated` | `{ part: Part, delta?: string }` | `agent.message` o `agent.tool`, según `part.type` |
| `todo.updated` | `{ sessionID, todos: Todo[] }` | `steps.updated` |
| `file.edited` | `{ file: string }` | `agent.file_edited` |
| `permission.updated` | `Permission` | `agent.permission_denied` (diagnóstico) |
| `session.diff` | `{ sessionID, diff: FileDiff[] }` | `agent.diff` (informativo) |

Más dos que **solo aparecen en runtime** y que sí nos sirven:

| Evento | Payload | Evento de dominio |
|---|---|---|
| `message.part.delta` | (a confirmar) | `agent.message` — probablemente **el** portador de los deltas de texto |
| `server.heartbeat` | (a confirmar) | señal de vida del contenedor: mejor que inventar la nuestra |

El resto **se ignora**: `lsp.*`, `pty.*`, `tui.*`, `installation.*`, `file.watcher.updated`,
`vcs.branch.updated`, `message.removed`, `session.created/deleted`, `command.executed`,
`session.compacted`, `permission.replied`, `server.instance.disposed`, y los no documentados
`plugin.added`, `catalog.updated`, `reference.updated`, `integration.updated`.

⚠️ `plugin.added` fue **45 de 79 eventos (57%)** en la corrida de prueba. El filtrado no es
cosmético: sin él se escribe basura en `run_events` y se satura el navegador.

🟢 El traductor hace `switch (event.type)` tratando `event` como `{ type: string }`, **no** como
la unión del SDK: ya sabemos que llegan tipos fuera de ella. El `default` loguea a nivel debug y
sigue. Así una versión futura de opencode no rompe nada.

### `Part` — cómo distinguir texto de herramienta

```ts
type Part = TextPart | ReasoningPart | FilePart | ToolPart | StepStartPart | StepFinishPart
          | SnapshotPart | PatchPart | AgentPart | RetryPart | CompactionPart | subtask;

type ToolPart = { type: "tool"; callID: string; tool: string; state: ToolState };
// ToolStateRunning   -> { status: "running",   input, title?, time: { start } }
// ToolStateCompleted -> { status: "completed", input, output, title, time: { start, end } }
```

```ts
// OJO: hay que manejar tambien `message.part.delta`, que existe en runtime pero NO
// en la union de tipos del SDK. Ver docs/13.
case "message.part.delta":
case "message.part.updated": {
  const { part, delta } = event.properties;
  if (part.type === "text")      return emitThrottled("agent.message", { text: delta ?? part.text });
  if (part.type === "reasoning") return; // ruido: no se muestra
  if (part.type === "tool")      return emit("agent.tool", {
    callId: part.callID,
    name:   part.tool,
    title:  part.state.title ?? part.tool,   // <- texto listo para mostrar
    status: part.state.status,
  });
}
```

🟢 `ToolState.title` viene listo para mostrar ("Reading package.json", etc.). No hay que inventar
descripciones por herramienta ni mantener un diccionario.

### `session.status` — el retry que no teníamos contemplado

```ts
type SessionStatus = { type: "idle" } | { type: "busy" }
                   | { type: "retry"; attempt: number; message: string; next: number };
```

🟢 El caso `retry` se emite a la UI como `agent.retrying`. Es exactamente lo que el usuario
necesita ver cuando el proveedor está rate-limiteando y el run parece congelado. Sin esto, media
hora de silencio es indistinguible de un cuelgue.

## Detección de pasos: `todo.updated`, no marcadores de texto

```ts
type Todo = { id: string; content: string; status: string; priority: string };
// status: pending | in_progress | completed | cancelled
```

opencode trae lista de tareas nativa. El agente la mantiene con su herramienta de todos, y cada
cambio dispara `todo.updated` **con el array completo**.

🟢 Ventajas sobre el parseo de marcadores que proponía la v1:

- Estructurado: no se parsea prosa.
- Llega el array entero, no deltas: la UI se sincroniza sin reconstruir estado ni preocuparse por
  eventos perdidos.
- Hay endpoint de lectura (`GET /session/{id}/todo`) para recuperarse de cualquier desincronización.

### Cómo se mapean los todos a nuestros 7 pasos

El prompt del agente ([06](./06-agente-mantenimiento.md)) le pide crear **exactamente** los 7
todos de las fases, con su `content` igual al título de la fase. El traductor los relaciona por
posición y por texto normalizado:

```ts
case "todo.updated": {
  const steps = event.properties.todos.map((t, i) => ({
    seq:    i,
    key:    matchPhaseKey(t.content) ?? `unknown-${i}`,
    title:  t.content,
    status: mapTodoStatus(t.status),   // pending|in_progress|completed|cancelled -> nuestro enum
  }));
  await upsertSteps(runId, steps);
  emit("steps.updated", { steps });
}
```

⚠️ **Sigue dependiendo de que el modelo mantenga la lista con disciplina** (I7b, pendiente de
verificar en el primer run real). Pero el modo de falla cambió: antes era "el parser se rompe",
ahora es "la lista queda desactualizada", que degrada suavemente.

🟢 **La fuente autoritativa sigue siendo el JSON final.** Al cerrar el run, `run_steps` se
reconcilia con el array `steps` del informe validado. Los todos mueven la UI en vivo; el JSON
define lo que queda en el histórico. Si el modelo descuidó los todos, el histórico igual sale
bien.

## Eventos de dominio

```ts
type RunEvent =
  | { type: "run.status";        payload: { status: RunStatus; at: number } }
  | { type: "run.connected";     payload: { containerId: string } }
  | { type: "steps.updated";     payload: { steps: StepView[] } }
  | { type: "agent.message";     payload: { text: string } }          // delta, throttled
  | { type: "agent.tool";        payload: { callId: string; name: string; title: string; status: string } }
  | { type: "agent.retrying";    payload: { attempt: number; message: string; nextAt: number } }
  | { type: "agent.file_edited"; payload: { path: string } }
  | { type: "run.pr_created";    payload: { number: number; url: string } }
  | { type: "run.report_ready";  payload: { artifactId: string } }
  | { type: "run.completed";     payload: { healthScore: number; findingsCount: number; headline: string } }
  | { type: "run.failed";        payload: { code: string; message: string } };
```

🟢 `run.completed` lleva lo mínimo para actualizar la UI; el informe completo se busca con un
`GET`. Un SSE no es lugar para un JSON de 100 KB.

## Endpoint SSE

```
GET /api/runs/:id/events
Accept: text/event-stream
Last-Event-ID: 42        (opcional, lo manda el navegador al reconectar)
```

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no          <- imprescindible si hay nginx delante
```

Formato de cada evento:

```
id: 43
event: steps.updated
data: {"steps":[{"seq":2,"key":"dependency-research","title":"Investigacion de dependencias","status":"running"}]}

```

### Reconexión

```
1. El navegador se reconecta con Last-Event-ID: 42
2. La API lee run_events WHERE run_id = ? AND id > 42 ORDER BY id
3. Los reemite todos (replay), y recien despues suscribe al bus en vivo
4. Si el run ya termino: replay completo + evento final + cierre del stream
```

🟢 `run_events.id` es `INTEGER PRIMARY KEY AUTOINCREMENT` justamente para esto: necesitamos un
cursor monótono global. Con UUIDs no habría forma de decir "todo lo posterior a X".

🟢 `steps.updated` es **idempotente** (lleva el estado completo), así que un replay parcial o
duplicado no corrompe la vista. Fue otra razón para preferirlo sobre eventos incrementales.

### Heartbeat

Cada 15 s, un comentario SSE:

```
: ping

```

Sin esto, proxies y balanceadores cierran la conexión durante las fases largas (el agente puede
pasar minutos investigando sin emitir nada).

### Cierre

El servidor cierra el stream al emitir `run.completed` / `run.failed` / `run.cancelled`. El
cliente debe llamar `eventSource.close()` al recibirlos: si no, `EventSource` reconecta para
siempre.

## Event Bus (fan-out)

Un `EventEmitter` en memoria indexado por `runId`. Varias pestañas pueden mirar el mismo run.

```ts
class RunEventBus {
  private subs = new Map<string, Set<(e: StoredEvent) => void>>();

  async publish(runId: string, event: RunEvent) {
    const stored = await db.insertRunEvent(runId, event);  // 1. persistir
    this.subs.get(runId)?.forEach((fn) => fn(stored));     // 2. emitir
  }

  subscribe(runId: string, fn: (e: StoredEvent) => void): () => void { /* devuelve unsubscribe */ }
}
```

🟢 Si el proceso muere se pierde el bus pero no los eventos: al reconectar, el replay desde
SQLite reconstruye todo. Limitación asumida de v1: un solo proceso.

## Control de volumen

`message.part.updated` puede emitir deltas de texto a altísima frecuencia. Sin control, se
escribe basura en SQLite y se satura el navegador.

| Medida | Valor 🟡 |
|--------|----------|
| Throttle de `agent.message` | Acumular deltas y emitir cada **500 ms** o cada 400 caracteres, lo que ocurra primero. |
| `reasoning` parts | **No se emiten.** Son ruido y pueden ser enormes. |
| `steps.updated` | Sin throttle: es de baja frecuencia y siempre vale la pena. |
| Tamaño máximo de payload | 8 KB; se trunca con `"…"` y marca `truncated: true`. |
| Eventos persistidos por run | Tope duro de 5.000. Superado, se siguen emitiendo en vivo pero solo se persisten `steps.*` y `run.*`. |
| Retención | 30 días (ver [02](./02-modelo-de-datos.md)). |

## Autorización del stream

🟢 El endpoint SSE exige la **misma sesión** que el resto de la API: `run.user_id` debe coincidir
con el usuario de la cookie. Un `runId` no es un secreto.

⚠️ `EventSource` no permite mandar headers propios, así que la autorización va por **cookie**
(`withCredentials: true`). Otra razón para que la sesión viva en cookie `httpOnly` y no en un
token en `localStorage`.

## Consumo desde el frontend

```ts
const es = new EventSource(`/api/runs/${runId}/events`, { withCredentials: true });

es.addEventListener("steps.updated",  (e) => setSteps(JSON.parse(e.data).steps));
es.addEventListener("agent.tool",     (e) => setActivity(JSON.parse(e.data)));
es.addEventListener("agent.retrying", (e) => setRetry(JSON.parse(e.data)));
es.addEventListener("run.completed",  (e) => { refetchRun(); es.close(); });
es.addEventListener("run.failed",     (e) => { refetchRun(); es.close(); });

// EventSource reconecta solo y manda Last-Event-ID; no hay que implementar reintentos.
```

🟢 El navegador **no** reconstruye estado: al montar la vista hace `GET /api/runs/:id` (estado
actual completo) y recién después abre el `EventSource`. Así nunca queda una pantalla vacía
esperando el primer evento.
