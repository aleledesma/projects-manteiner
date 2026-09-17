# 14 — Estado actual (handoff)

**Fecha: 2026-09-17.** Punto de traspaso a otro agente. Este documento es el que hay que leer
primero para retomar el trabajo.

---

## Resumen en una línea

Fases 0, 1 y 2 cerradas. En Fase 3 funcionan y fueron verificados contra GitHub real el callback
de la GitHub App, el listado de repos autorizados y su vinculación mediante la consola del
navegador; la UI se pospuso. La conexión base a Docker, el token de clon restringido y la imagen
`manteiner-git` están implementados. La API ya valida el tamaño, clona en un volumen efímero con
Dockerode, entrega ese volumen al siguiente paso y garantiza su limpieza en `finally`.

## Qué está hecho y funcionando

| | Estado | Verificación |
|---|---|---|
| Planificación completa (docs 00-13) | ✅ | 5 revisiones registradas |
| Fase 0 — spikes de verificación | ✅ cerrada | [13](./13-hallazgos-spike.md) |
| Monorepo npm workspaces | ✅ | `apps/api`, `apps/web`, `packages/contracts`, `spikes` |
| API Fastify + config + errores + logging + SQLite + cifrado + auth + Docker | ✅ | 53 tests |
| `packages/contracts` | ✅ | 50 tests |
| Contrato base verificado contra opencode real | ✅ | I5 cerrado; hardening posterior cubierto localmente |
| Base de datos SQLite | ✅ | 15 tablas + 3 migraciones |
| Cifrado AES-256-GCM | ✅ | IV aleatorio + AAD + 10 tests específicos |
| Fase 2 — Better Auth + web mínima | ✅ cerrada | Smoke test real completado |
| Fase 3 — GitHub App y repositorios | 🟡 | Backend verificado; UI de repos diferida; clon real verificado |
| Conexión Dockerode | ✅ | Detección local + `ping`/`version`; `/api/health` expone solo disponibilidad |
| Token de clon por repositorio | ✅ | `contents: read`, un `repository_id`, sin caché; revocado tras clonar |
| Imagen `manteiner-git` | ✅ | Build y clon real verificados; corre como UID 10001 |
| Workspace efímero | ✅ | Tamaño previo + Dockerode + callback + limpieza real verificada |
| Fases 4 a 9 | 🔲 | [roadmap](./11-roadmap.md) |

**Comprobalo:**

```bash
npm ci && npm test             # 103/103
npm run typecheck              # limpio
npm run dev                    # curl http://localhost:3001/api/health
```

## Lo que sigue, en orden

### Resolver la sincronización de repositorios

- Resolver A5: webhooks en v1 o re-sincronización on-demand.
- Después, avanzar con proveedores de IA y la ejecución del agente.

I9 (calibración del tamaño) e I10 (comprobación de que el token no aparece en `/proc`) quedan
diferidos hasta que el flujo de ejecución completo sea funcional; no bloquean el desarrollo actual.

### Decisión abierta que queda

Solo **A5**: si implementar webhooks de GitHub en v1 o re-sincronizar los repos en cada carga del
dashboard. Es de Fase 3, no bloquea nada ahora.

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
  services/auth.ts Configura GitHub, sesiones y descarte de tokens OAuth.
  services/github-app.ts JWT de App, tokens efimeros y llamadas a GitHub.
  services/docker.ts Conexion al daemon, estado y error DOCKER_UNAVAILABLE.
  services/repository-workspace.ts Tamaño, volumen, clon Dockerode y limpieza garantizada.
  services/credential-crypto.ts  AES-256-GCM para credenciales de proveedores.
  errors.ts       AppError + handler unico. Forma { error: { code, message } }.
  server.ts       buildServer(config) -> NO escucha, para que los tests usen inject().
  index.ts        Entrypoint: valida config, arranca, maneja SIGTERM/SIGINT.
  routes/health.ts

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
  App.tsx          Sesión iniciada y logout; usa los componentes visuales existentes.
  auth-client.ts  Cliente React de Better Auth.

docker/git/
  Dockerfile       Imagen manteiner-git: Alpine + Git, usuario 10001.
  clone.sh         Clon depth 1; token por stdin/FIFO; elimina origin.
```

### Dos invariantes que no hay que romper

1. **`maintenance-report.ts` no lleva transforms ni `.default()`.** `z.toJSONSchema()` emite el
   tipo de *salida*, así que un transform haría que el JSON Schema publicado difiera de lo que se
   le pide al modelo. Las normalizaciones van en `normalize.ts`, aparte.

2. **`normalize.ts` nunca rechaza un informe entero.** Corrige lo corregible y anota el resto en
   `warnings`. Perder una auditoría de 20 minutos porque una URL era `http` sería absurdo.

---

## Comandos útiles

```bash
npm test                                              # 103 tests
npm run typecheck
npm run dev                                           # API en :3001
npm run dev:web                                       # web en :5173
npm run docker:build:git                              # imagen manteiner-git:0.1.0

npm run print-schema --workspace @manteiner/contracts # el JSON Schema del informe
npm run contract --workspace manteiner-spikes -- --dry-run   # verifica sin gastar tokens
npm run contract --workspace manteiner-spikes                # corrida completa contra opencode
npm run device-flow --workspace manteiner-spikes             # re-autenticar OpenAI
```

## Cómo se trabaja en este proyecto

- **Paso a paso.** El usuario quiere entender cada pieza; no construir fases enteras de una.
- **Las decisiones se registran**, incluidas las descartadas y por qué.
  [12](./12-decisiones-abiertas.md) tiene 19 decisiones y 7 revisiones.
- **Verificar antes de construir**, pero solo lo que puede cambiar la arquitectura. El spike 3 se
  salteó aplicando ese criterio; sus preguntas pasaron a criterios de aceptación de las fases 3 y 5.
- **No dejar procesos corriendo.** Verificar por PID después de levantar cualquier servidor.
