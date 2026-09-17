# 04 — Proveedores de IA y opencode SDK

Fuentes: <https://opencode.ai/docs/sdk/>, `/docs/server/`, `/docs/providers/`,
`/docs/config/`, `/docs/agents/`, `/docs/permissions/`, `/docs/cli/`.

## Lo que el SDK nos da

```bash
npm install @opencode-ai/sdk
```

Dos formas de obtener un cliente:

```js
// A) levanta el servidor y devuelve el cliente (proceso local)
import { createOpencode } from "@opencode-ai/sdk"
const { client, server } = await createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  config: { model: "anthropic/claude-sonnet-4-5" },
})

// B) solo cliente, contra un servidor ya corriendo  <-- lo que usamos nosotros
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:49231" })
```

🟢 **Usamos (B)**: el servidor de opencode corre *dentro del contenedor* y la API se
conecta desde afuera. Ver [05](./05-ejecucion-en-docker.md).

`createOpencodeClient` acepta un `fetch` propio — así inyectamos el header de
autenticación básica del servidor:

```js
const auth = "Basic " + Buffer.from(`opencode:${runPassword}`).toString("base64")
const client = createOpencodeClient({
  baseUrl,
  fetch: (input, init = {}) =>
    fetch(input, { ...init, headers: { ...init.headers, Authorization: auth } }),
})
```

### Namespaces relevantes

| Namespace | Métodos que usamos |
|-----------|--------------------|
| `client.path.get()` | Sonda de vida. ⚠️ `client.global.health()` **no existe** en el SDK pese a la doc: `Global` solo expone `event()`. |
| `client.config.providers()` | **Catálogo de proveedores y modelos.** Devuelve `{ providers, default }`. |
| `client.auth.set({ path: { id }, body })` | Cargar la credencial del proveedor. |
| `client.session.create({ body: { title } })` | Crear la sesión del run. |
| `client.session.prompt({ path, body })` | Enviar el prompt; soporta `format: json_schema`. |
| `client.session.abort({ path: { id } })` | Cancelar. |
| `client.session.messages({ path: { id } })` | Traza completa al terminar. |
| `client.event.subscribe()` | Stream de eventos en vivo (async iterator). |
| `client.app.agents()` | Listar agentes disponibles. |

## Catálogo de proveedores y modelos

🟢 El catálogo lo provee **opencode**, no lo hardcodeamos:

```js
const { providers, default: defaults } = await client.config.providers()
```

Problema práctico: para llamar a `config.providers()` hace falta un servidor de opencode
corriendo, y no queremos levantar un contenedor cada vez que el usuario abre la pantalla
de configuración.

🟢 **Solución: un "catalog container" de vida corta y un caché.**

```
Al arrancar la API (y luego cada 24h, o bajo demanda con "Actualizar catalogo"):
  1. docker run --rm  manteiner-agent  (sin workspace, red minima)
  2. cargar por `auth.set` la credencial activa, si existe
  3. client.config.providers()
  4. filtrar modelos sin `capabilities.toolcall === true`
  5. guardar solo metadata segura en data/provider-catalog.json  (+ timestamp)
  6. destruir el contenedor
```

La pantalla de configuración lee del caché. Es instantánea y no depende de Docker. Si el caché
está vencido se sirve la última copia válida mientras el refresh corre en background; el endpoint
de refresh explícito sí informa un error si Docker o el proveedor no están disponibles. En la v1
single-user el catálogo autenticado representa la cuenta activa más reciente.

Alternativa 🟡: `opencode models --refresh` vía CLI en el mismo contenedor, si resulta más
simple que el endpoint.

Lo que la UI necesita mostrar por modelo — 🔴 **a verificar contra la forma real de la
respuesta** (inspeccionar `GET /doc`, el OpenAPI del servidor): id, nombre para mostrar,
límites de contexto/salida, si soporta tool calling, y costo por millón de tokens si viene.
El agente de mantenimiento **requiere tool calling**; los modelos que no lo soporten deben
filtrarse de la lista.

## Autenticación de proveedores

### Cómo funciona en opencode

- Las credenciales viven en `~/.local/share/opencode/auth.json` dentro del entorno donde corre opencode.
- El CLI las carga con `opencode auth login` (interactivo).
- El SDK las carga con:

```js
await client.auth.set({
  path: { id: "anthropic" },
  body: { type: "api", key: "sk-ant-..." },
})
```

- Alternativa sin tocar `auth.json`: `opencode.json` con `{env:VAR}`:

```json
{
  "provider": {
    "anthropic": { "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" } }
  }
}
```

### v1 — proveedores por API key 🟢

Flujo completo:

```
1. UI: el usuario elige proveedor del catalogo y pega su API key.
2. POST /api/providers  { provider_id, api_key, label }
3. La API valida la key:
     - levanta un contenedor de verificacion efimero
     - client.auth.set({ path:{id}, body:{ type:"api", key } })
     - crea una sesion y manda un prompt trivial ("responde OK") con el modelo mas barato
     - si responde -> valida
4. Cifra la key con AES-256-GCM (MASTER_KEY) y la guarda en `provider_credentials`.
   Guarda solo los ultimos 4 caracteres en claro, para mostrar.
5. Destruye el contenedor de verificacion.
```

Al lanzar un run, la key se descifra en memoria y se entrega al contenedor. **Dos opciones
para entregarla — 🟡 decidir:**

| | Cómo | Pro | Contra |
|---|---|---|---|
| **(1) Variable de entorno** | `docker create --env ANTHROPIC_API_KEY=...` + `opencode.json` con `{env:...}` | Simple, es el mecanismo nativo de opencode. | Visible en `docker inspect` y en el entorno de cualquier proceso del contenedor. |
| **(2) `auth.set` por HTTP** | El contenedor arranca sin credenciales; la API llama `client.auth.set()` apenas está listo. | La key nunca aparece en la config del contenedor ni en `docker inspect`. | Requiere que el servidor esté arriba antes de tener credenciales (hay que verificar que opencode lo permita). |

🟡 **Recomendación: (2)**, con (1) como fallback. Es estrictamente mejor desde el punto de
vista de exposición, y `client.auth.set` existe justamente para esto. 🔴 Verificar en la
implementación que `opencode serve` arranca sin credenciales cargadas.

### v1 — OpenAI con cuenta ChatGPT Plus/Pro (OAuth) 🟢

> **Revisión 2.** La v1 de este documento posponía OAuth a v2. Se investigó el código de
> opencode y el camino limpio existe: se implementa en v1.

#### Lo que confirmó la investigación

El almacén de credenciales de opencode (`packages/opencode/src/auth/index.ts`) define una
unión de tres tipos, y `set()` acepta cualquiera de ellos:

```typescript
export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}
```

Es decir: **`client.auth.set()` acepta `type: "oauth"`**. No hace falta parsear terminales ni
hacer ingeniería inversa de `auth.json`.

Mejor aún: el plugin de OpenAI de opencode (`src/plugin/openai/codex.ts`) implementa **dos**
métodos de autorización, y uno está pensado exactamente para nuestro caso:

- `ChatGPT Pro/Plus (browser)` — abre el navegador, callback en `localhost:1455`.
- **`ChatGPT Pro/Plus (headless)` — flujo device code.** Sin callback local, sin navegador en
  el servidor. Pensado para SSH, Docker y máquinas remotas.

🟢 **Usamos el flujo device code, implementado directamente en nuestra API.** No hace falta
ningún contenedor de autenticación: es HTTP puro contra `auth.openai.com`.

Esto **elimina** un componente que la idea original daba por necesario.

#### El flujo, paso a paso

Constantes (tomadas del plugin de opencode, que a su vez son las del CLI de Codex):

```ts
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER    = "https://auth.openai.com";
```

```
1. POST https://auth.openai.com/api/accounts/deviceauth/usercode
   body: { client_id: CLIENT_ID }
   -> { device_auth_id, user_code, interval }

2. La UI le muestra al usuario:
      "Entra a https://auth.openai.com/codex/device e ingresa el codigo: XXXX-XXXX"

3. POLLING cada `interval` segundos (+ margen):
   POST https://auth.openai.com/api/accounts/deviceauth/token
   body: { device_auth_id, user_code }
     - 403 o 404 -> todavia no autorizo, seguir esperando
     - otro error -> abortar
     - 200        -> { authorization_code, code_verifier }

4. Intercambio final (PKCE):
   POST https://auth.openai.com/oauth/token
   content-type: application/x-www-form-urlencoded
   body: grant_type=authorization_code
         code=<authorization_code>
         redirect_uri=https://auth.openai.com/deviceauth/callback
         client_id=<CLIENT_ID>
         code_verifier=<code_verifier>
   -> { access_token, refresh_token, expires_in, id_token }

5. accountId = claim extraido del JWT de id_token (o del access_token como fallback)

6. Guardar cifrado en `provider_credentials`:
   { type: "oauth", refresh, access, expires: Date.now() + expires_in*1000, accountId }
```

#### Inyección en el contenedor

Igual que una API key, pero con el otro tipo:

```js
await client.auth.set({
  path: { id: "openai" },
  body: { type: "oauth", refresh, access, expires, accountId },
});
```

#### Rotación del refresh token — ✅ medido en el spike 1

> Esta sección se reescribió con datos reales. Ver [13](./13-hallazgos-spike.md).

Dos mediciones que, combinadas, invierten la estrategia que habíamos planeado:

| Medición | Valor real | Se asumía |
|----------|-----------|-----------|
| Vida del access token | **864.000 s = 10 días** | ~1 hora |
| ¿Rota el refresh token? | **Sí, en cada uso** | desconocido |

El plan original era **refrescar proactivamente antes de cada run**. Con estos datos eso es
innecesario y además contraproducente:

- Un access token de 10 días sobrevive de sobra a cualquier run (timeout: 30 min). Nunca se va
  a vencer a mitad de camino.
- Como el refresh **rota**, cada refresco es una oportunidad de perder la credencial: si algo
  falla entre que OpenAI rota el token y que lo persistimos, el usuario tiene que reconectar.

🟢 **Regla: refrescar lo menos posible.**

```ts
// Antes de lanzar el contenedor:
if (cred.expires_at < Date.now() + RUN_TIMEOUT_MS + REFRESH_MARGIN_MS) {
  const nuevo = await refreshAccessToken(cred.refresh);
  await db.updateCredential(cred.id, nuevo);   // persistir ANTES de usarlo
  cred = nuevo;
}
// Invariante: el access token es válido durante todo el run.
```

```
POST https://auth.openai.com/oauth/token
  grant_type=refresh_token & refresh_token=<...> & client_id=<CLIENT_ID>
```

En la práctica esto refresca **una vez cada ~10 días por usuario**, no una vez por run.

🟢 **Ya no hace falta releer la credencial del contenedor.** Era la mitigación nº 2 del plan
anterior: temíamos que el plugin refrescara adentro y perdiéramos el token nuevo al destruir el
contenedor. Pero el plugin solo refresca si `expires < Date.now()`, y la invariante de arriba
garantiza lo contrario. El contenedor nunca refresca. Una llamada HTTP menos por run.

🟢 **El refresco es una sección crítica.** Persistir el par nuevo en una transacción
inmediatamente; si la persistencia falla, marcar la credencial `invalid` y pedir reconexión. Es
la única manera de perder el acceso, y la ventana es de milisegundos.

🔴 Queda por medir si el refresh viejo se invalida al instante o hay período de gracia. No
bloquea: "persistir primero" es correcto en ambos casos.

#### Claims aprovechables del `id_token`

El claim `https://api.openai.com/auth` trae, además del `accountId`:

- `chatgpt_plan_type` (`"plus"`, `"pro"`, …) → mostrarlo en la UI de configuración.
- `chatgpt_subscription_active_until` → 🟡 **avisar antes de que se venza la suscripción**, en
  lugar de que el usuario descubra el problema con un run fallido.

⚠️ El `id_token` también trae `email` y `name`. **No se almacenan**: la identidad del usuario
ya viene del login de GitHub, y guardar datos personales que no necesitamos solo agrega
superficie. Del `id_token` se extrae únicamente `chatgpt_account_id` y, opcionalmente, el plan
y la fecha de vencimiento.

#### Modelos disponibles por esta vía ⚠️

El plugin **filtra** qué modelos habilita cuando la autenticación es por suscripción. La
allowlist que tiene hoy el código es:

```ts
const ALLOWED_MODELS = new Set(["gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini"]);
```

con exclusiones explícitas de `gpt-5.5-pro` y `gpt-5.6`, y de todo modelo con
`reasoningMode: "pro"`.

✅ **Corregido con datos reales.** Esa allowlist es de la rama `dev` y **no** refleja el
catálogo efectivo. Medido contra `config.providers()` ya autenticado con una cuenta Plus
(opencode 1.18.30): **15 modelos, los 15 con tool calling**, incluidos `gpt-5.6-sol`,
`gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-6-astra` (1.050.000 de contexto) y `gpt-5.4`.

🟢 Confirma la decisión de **no hardcodear el catálogo**: lo que vale es lo que devuelve
`config.providers()` autenticado, no una constante del código fuente. Ver [13](./13-hallazgos-spike.md).

Además, el tráfico autenticado por OAuth no va a `api.openai.com` sino a
`https://chatgpt.com/backend-api/codex/responses`. Importa para el futuro proxy de egress.

#### Otros proveedores OAuth — v2 ✅ el camino existe

> Verificado en el spike 2 leyendo los tipos del SDK. Ver [13](./13-hallazgos-spike.md).

opencode **expone el flujo OAuth completo por HTTP**, así que no hay que replicar el de cada
proveedor:

```
GET  /provider/auth                   -> { [providerID]: { type: "oauth"|"api", label }[] }
POST /provider/{id}/oauth/authorize   body { method: <indice> }
                                      -> { url, method: "auto"|"code", instructions }
POST /provider/{id}/oauth/callback    body { method: <indice>, code?: string } -> boolean
```

El flujo de producto queda igual para todos: listar métodos → el usuario elige uno → mostrarle
`url` + `instructions` → esperar → callback.

⚠️ **Requiere un servidor de opencode vivo durante todo el flujo**, porque el estado del PKCE
vive ahí. Acá sí aparece el "contenedor efímero de autenticación" que preveía la idea original:
tenía razón, solo que hace falta para *estos* proveedores, no para OpenAI.

🟢 **Para OpenAI mantenemos el device flow propio** (ya probado, sin contenedor).
🟡 Para el resto, en v2, se usa esta vía con un contenedor de autenticación de vida corta.

⚠️ Riesgo asumido: `CLIENT_ID` e `ISSUER` son constantes de OpenAI que opencode hardcodea. Si
cambian, nuestro flujo se rompe hasta que actualicemos. Hay reportes de fallos `403` en el
intercambio de tokens del flujo *browser*; el flujo *device* es el más robusto de los dos, y
es el que usamos.

## Configuración de opencode dentro del contenedor

El runner genera un `opencode.json` por run:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "{env:MANTEINER_MODEL}",
  "small_model": "{env:MANTEINER_SMALL_MODEL}",
  "autoupdate": false,
  "share": "disabled",
  "snapshot": false,
  "server": { "hostname": "0.0.0.0", "port": 4096 },
  "instructions": [],
  "permission": {
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "list": "allow",
    "webfetch": "allow",
    "edit": {
      "*": "deny",
      "package.json": "allow",
      "package-lock.json": "allow",
      "pnpm-lock.yaml": "allow",
      "yarn.lock": "allow",
      "requirements.txt": "allow",
      "pyproject.toml": "allow",
      "go.mod": "allow",
      "go.sum": "allow",
      "Cargo.toml": "allow",
      "Cargo.lock": "allow"
    },
    "bash": {
      "*": "deny",
      "npm outdated*": "allow",
      "npm view*": "allow",
      "npm ls*": "allow",
      "npm install --package-lock-only*": "allow",
      "pnpm outdated*": "allow",
      "yarn outdated*": "allow",
      "pip list*": "allow",
      "go list*": "allow",
      "cargo tree*": "allow",
      "git log*": "allow",
      "git diff*": "allow",
      "git status*": "allow"
    },
    "external_directory": "deny"
  },
  "agent": {
    "maintainer": {
      "description": "Auditoria de mantenimiento de repositorios",
      "mode": "primary"
    }
  },
  "default_agent": "maintainer"
}
```

Claves de este diseño:

- 🟢 `edit` en **deny por defecto** con allowlist de manifiestos. El agente no puede tocar
  código fuente aunque el modelo decida hacerlo. Es la mitad del control; la otra mitad es
  la validación del diff en el contenedor de publicación sin LLM ([03](./03-autenticacion-github.md)).
- 🟢 `bash` en **deny por defecto** con allowlist de comandos de solo consulta.
  Nada de `npm install` completo (ejecuta scripts arbitrarios del paquete);
  `--package-lock-only` actualiza el lockfile sin ejecutar nada.
- 🟢 `autoupdate: false` — el contenedor debe ser reproducible.
- 🟢 `share: "disabled"` — jamás publicar sesiones con código de usuarios.
- 🟢 `snapshot: false` — no necesitamos el historial interno de opencode; el git del
  workspace ya nos da el diff.
- 🟢 `external_directory: "deny"` — el agente no sale de `/work/repo`.
- 🟢 Por defecto opencode **deniega archivos `.env`**. Se mantiene.

## Structured output

Es la pieza que hace que el contrato JSON sea confiable:

```js
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    model: { providerID, modelID },
    parts: [{ type: "text", text: PROMPT }],
    format: { type: "json_schema", schema: MAINTENANCE_REPORT_SCHEMA },
  },
})

const report = result.data.info.structured   // <- OJO: `structured`, NO `structured_output`
```

⚠️ **La documentación de opencode dice `structured_output`, pero el campo real es
`structured`.** Verificado contra opencode 1.18.30 en el paso 1.3; ver
[13](./13-hallazgos-spike.md). Conviene leer con fallback a ambos nombres por si cambia.

⚠️ Con autenticación **por suscripción** la respuesta trae `cost: 0`: no se reporta costo por
token. La estimación de gasto por run solo va a funcionar con proveedores por API key.

Manejo de error documentado:

```js
if (result.data.info.error?.name === "StructuredOutputError") {
  // no logro producir JSON valido; result.data.info.error.retries tiene los intentos
}
```

🟢 Aun así, **revalidamos siempre con Zod en el host**. Structured output garantiza la
forma, no la coherencia semántica (por ejemplo, que `findings_count` coincida con el array,
o que las URLs de referencias sean https).

## Riesgos y cosas a verificar 🔴

| Item | Cómo verificarlo |
|------|------------------|
| Forma exacta de `config.providers()` | `curl http://localhost:4096/doc` sobre un contenedor de prueba. |
| ~~¿`POST /auth/{id}` soporta `type: "oauth"`?~~ | ✅ **Resuelto:** sí. `Auth.Info` es la unión `Oauth \| Api \| WellKnown`. |
| ¿Existe un endpoint que exponga `authorize()` por HTTP? | En el OpenAPI spec. Si existe, habilita todos los proveedores OAuth sin replicar flujos. |
| ¿Se puede **leer** la credencial vigente por HTTP (`get`/`all`)? | Condiciona la mitigación 2 de rotación del refresh token. |
| Qué modelos habilita OpenAI vía OAuth de suscripción | `config.providers()` con la credencial OAuth ya cargada. |
| Nombres exactos de los eventos de `event.subscribe()` | Loguear el stream crudo en un run de prueba. Ver [07](./07-progreso-sse.md). |
| ¿`opencode serve` arranca sin credenciales? | Prueba directa. Condiciona la opción (2) de entrega de API key. |
| Límite de tamaño del JSON Schema aceptado | Probar con el schema completo de [06](./06-agente-mantenimiento.md). |
| Comportamiento de `permission` con `bash` deny + herramientas internas | Verificar que el agente no quede bloqueado por completo. |

Estas verificaciones son la **primera tarea técnica del roadmap** ([11](./11-roadmap.md), Fase 0).
