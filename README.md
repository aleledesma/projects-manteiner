# Manteiner

Conecta repositorios de GitHub y ejecuta **agentes de IA de mantenimiento** sobre ellos dentro
de contenedores efímeros de Docker. El agente audita el repo, abre un PR con actualizaciones
seguras, devuelve un informe estructurado y genera un PDF, mostrando el progreso en tiempo real.

📚 **La planificación completa está en [`docs/`](./docs/README.md).** Empezá por
[00 — Visión](./docs/00-vision.md) y [01 — Arquitectura](./docs/01-arquitectura.md).

## Estado

👉 **Para retomar el trabajo, leé [`docs/14-estado-actual.md`](./docs/14-estado-actual.md).**

| Fase | Estado |
|------|--------|
| 0 — Verificación técnica | ✅ cerrada ([hallazgos](./docs/13-hallazgos-spike.md)) |
| 1 — Esqueleto y persistencia | ✅ cerrada — API, contratos, SQLite y cifrado listos. |
| 2 — Autenticación | ✅ cerrada y verificada contra GitHub real. |
| 3 — GitHub App y repositorios | 🟡 instalación/listado/vinculación listos; conexión Docker implementada. |
| 4 a 9 | 🔲 pendientes ([roadmap](./docs/11-roadmap.md)) |

91 tests pasando · typecheck limpio · el contrato base del agente fue aceptado por opencode.

## Requisitos

- **Node.js 22.12+** (requerido por Vite 8)
- **Docker** (a partir de la Fase 3)

## Puesta en marcha

```bash
npm install

cp .env.example .env
# Genera los dos secretos obligatorios:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# pegalos en MASTER_KEY y SESSION_SECRET, y completa las credenciales de GitHub
# callback de la OAuth App: http://localhost:3001/api/auth/callback/github
# callback de la GitHub App: http://localhost:3001/api/github/setup

# terminal 1
npm run dev
# terminal 2
npm run dev:web
```

La API queda en <http://localhost:3001> y la web en <http://localhost:5173>. Probá:

```bash
curl http://localhost:3001/api/health
```

Si falta un secreto obligatorio, **la API no arranca** y te dice exactamente qué falta.
Es deliberado: mejor caer con un mensaje claro que correr sin cifrado.

`GET /api/health` también informa si el daemon de Docker está disponible. Docker apagado no
impide iniciar sesión ni administrar repositorios, pero impedirá ejecutar futuros runs.

En producción la SPA y `/api` deben publicarse bajo el mismo origen. El reverse proxy sirve la
web y dirige `/api/*` a Fastify; `PUBLIC_URL` y `WEB_URL` usan esa misma URL pública.

## Comandos

| Comando | Qué hace |
|---------|----------|
| `npm run dev` | API en modo watch |
| `npm run dev:web` | React/Vite en modo desarrollo |
| `npm run build` | Build de los workspaces que lo requieren |
| `npm test` | Tests de todos los workspaces |
| `npm run typecheck` | `tsc --noEmit` en todos los workspaces |
| `npm run print-schema --workspace @manteiner/contracts` | Imprime el JSON Schema del informe |
| `npm run db:generate --workspace @manteiner/api` | Genera migraciones al cambiar el schema Drizzle |

## Estructura

```
apps/
  api/                 Fastify + orquestador + SQLite
  web/                 React + Vite + cliente de Better Auth
packages/
  contracts/           Contrato del agente: Zod, JSON Schema y prompts versionados
docs/                  Planificación y decisiones
spikes/                Scripts descartables de verificación (Fase 0)
```

`packages/contracts` es la pieza central: define **una sola vez** la forma del informe que
devuelve el agente, y de ahí salen el JSON Schema que restringe al modelo, la validación en el
host y los tipos del frontend. No se pueden desincronizar.

## Cómo se toman las decisiones acá

Todo lo decidido —y lo descartado, con su motivo— vive en
[`docs/12-decisiones-abiertas.md`](./docs/12-decisiones-abiertas.md). Las revisiones registran
el planteo original, la objeción y la resolución: saber por qué **no** se hizo algo vale tanto
como saber qué se hizo.
