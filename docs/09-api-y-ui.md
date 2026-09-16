# 09 — API y UI

## Convenciones de la API

- Base: `/api`. Todo JSON salvo SSE y descargas.
- Autenticación por **cookie de sesión** (`httpOnly`). Sin tokens en `localStorage`.
- Errores con forma uniforme:

```json
{ "error": { "code": "PROVIDER_AUTH_FAILED", "message": "La credencial fue rechazada por el proveedor." } }
```

- 🟢 El `code` es estable y apto para que el frontend ramifique. El `message` es para humanos
  y puede cambiar.
- 🟢 Mutaciones con efecto externo (crear run) aceptan `Idempotency-Key`. Un doble click no
  debe generar dos PRs.

## Endpoints

### Sistema

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/health` | Estado de la API, versión del contrato y disponibilidad de Docker. |

Docker apagado se informa como `{ "docker": { "available": false } }` sin marcar la API como
caída: autenticación y configuración siguen funcionando, pero antes de ejecutar un run se usará
`DOCKER_UNAVAILABLE`.

### Autenticación

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/auth/sign-in/social` | Inicia OAuth con `{ provider: "github" }`. |
| `GET` | `/api/auth/callback/github` | Callback administrado por Better Auth. |
| `GET` | `/api/auth/get-session` | Sesión para el cliente web de Better Auth. |
| `POST` | `/api/auth/sign-out` | Borra la sesión. |
| `GET` | `/api/me` | Usuario actual + estado de onboarding. |

`GET /api/me` responde con lo que la UI necesita para decidir qué pantalla mostrar:

```json
{
  "user": { "id": "...", "githubLogin": "...", "avatarUrl": "..." },
  "onboarding": { "hasProvider": true, "hasInstallation": true, "hasRepos": false }
}
```

### GitHub

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/github/install-url` | URL de instalación de la App (con `state`). |
| `GET` | `/api/github/setup` | Callback post-instalación. |
| `GET` | `/api/github/available-repos` | Repos de las instalaciones, aún no vinculados. |

Los tres endpoints están implementados. `install-url` guarda solamente el hash de un `state`
aleatorio y `setup` exige sesión, consume ese estado una sola vez, comprueba con una autorización
temporal de GitHub que el usuario puede acceder a la instalación y revoca el token al terminar.
`POST /api/github/webhook` queda pendiente junto con la decisión entre webhooks y sincronización
on-demand.

### Repositorios

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/repos` | Repos vinculados. |
| `POST` | `/api/repos` | Vincula uno (`{ githubRepoId }`). |
| `GET` | `/api/repos/:id` | Detalle + preferencia de modelo. |
| `PATCH` | `/api/repos/:id` | Actualiza preferencias (modelo por repo). |
| `DELETE` | `/api/repos/:id` | Desvincula (soft delete; los runs se conservan). |

Por ahora están implementados `GET /api/repos` y `POST /api/repos`; el resumen del último run y
las operaciones sobre un repo individual llegan con las fases que consumen esos datos.

### Proveedores de IA

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/providers/catalog` | Catálogo de opencode (desde caché). Ver [04](./04-proveedores-ia-opencode.md). |
| `POST` | `/api/providers/catalog/refresh` | Fuerza refresco del catálogo. |
| `GET` | `/api/providers` | Credenciales del usuario (sin secretos). |
| `POST` | `/api/providers` | Agrega credencial **por API key**. Valida antes de guardar. |
| `POST` | `/api/providers/oauth/:providerId/start` | Inicia el device flow. Devuelve `{ url, userCode, expiresIn, pollToken }`. |
| `GET` | `/api/providers/oauth/:providerId/status` | Estado del device flow: `pending` \| `authorized` \| `expired` \| `failed`. |
| `DELETE` | `/api/providers/:id` | Elimina credencial. |
| `PUT` | `/api/preferences/model` | Modelo por defecto del usuario. |

`GET /api/providers` nunca devuelve la key:

```json
[{ "id": "...", "providerId": "anthropic", "label": "Personal",
   "lastFour": "9f2a", "status": "active", "verifiedAt": 1757900000000 }]
```

### Runs

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/repos/:id/runs` | Dispara una auditoría. `{ auditType, modelOverride? }`. |
| `GET` | `/api/repos/:id/runs` | Histórico paginado del repo. |
| `GET` | `/api/runs/:id` | Estado completo: run + steps + findings + artefactos. |
| `GET` | `/api/runs/:id/events` | **SSE**. Ver [07](./07-progreso-sse.md). |
| `DELETE` | `/api/runs/:id` | Cancela si está activo; borra si terminó. |
| `POST` | `/api/runs/:id/report` | Regenera el PDF. |
| `GET` | `/api/runs/:id/artifacts/:artifactId` | Descarga. |
| `GET` | `/api/runs/:id/diff` | El patch en texto plano. |

`POST /api/repos/:id/runs` rechaza con `409 RUN_ALREADY_ACTIVE` si el repo ya tiene un run en
curso, y con `412 PROVIDER_NOT_CONFIGURED` si falta credencial o modelo.

### Comparación entre runs — 🟡 v1.1

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/repos/:id/findings/trend` | Hallazgos por `finding_key` a lo largo del tiempo: cuáles persisten, cuáles se resolvieron, cuáles son nuevos. |

Es la funcionalidad que convierte el histórico en algo más que una lista. Depende de que
`finding_key` sea realmente estable ([06](./06-agente-mantenimiento.md)), así que conviene
implementarla después de tener varios runs reales para validarlo.

## Pantallas

### 1. Login
Una pantalla, un botón: *Continuar con GitHub*. Explica en una línea qué hace la app y qué
permisos va a pedir.

### 2. Onboarding (3 pasos, con progreso visible)

```
[1] Conectar proveedor de IA    -> elegir proveedor, pegar API key, elegir modelo
[2] Instalar la GitHub App      -> redirect a GitHub, elegir repos
[3] Vincular repositorios       -> lista de repos disponibles, checkbox
```

🟢 Se puede completar en cualquier orden, pero no se puede disparar un run hasta tener los
tres. El estado viene de `GET /api/me`.

El paso 1 tiene **dos caminos** según el proveedor:

```
+---------------------------------------------------------------+
|  Conectar proveedor de IA                                     |
|                                                               |
|  ( ) OpenAI  - cuenta ChatGPT Plus/Pro        [recomendado]   |
|  ( ) OpenAI  - API key de plataforma                          |
|  ( ) Anthropic - API key                                      |
|  ( ) OpenRouter, Groq, ...                                    |
|                                                               |
|  [ Continuar ]                                                |
+---------------------------------------------------------------+
```

Si elige **API key**: un input, se valida contra el proveedor y se guarda cifrada.

Si elige **cuenta ChatGPT Plus/Pro** (device flow, ver [04](./04-proveedores-ia-opencode.md)):

```
+---------------------------------------------------------------+
|  Conectá tu cuenta de ChatGPT                                 |
|                                                               |
|   1. Abri este enlace:                                        |
|      https://auth.openai.com/codex/device        [ Abrir ]    |
|                                                               |
|   2. Ingresa este codigo:                                     |
|                                                               |
|            +---------------------+                            |
|            |     WDJB - MJHT     |   [ Copiar ]               |
|            +---------------------+                            |
|                                                               |
|   Esperando autorizacion...  (expira en 9:42)                 |
+---------------------------------------------------------------+
```

Detalles que importan — 🟡:

- El polling lo hace el **backend**, no el navegador: el frontend solo consulta
  `/status`. Así el flujo sobrevive a que el usuario cierre la pestaña.
- Mostrar el código en grande, monoespaciado y con el guion: se copia a mano.
- Mostrar el tiempo restante. Si expira, ofrecer reintentar sin salir de la pantalla.
- Aclarar que una cuenta Plus/Pro **no** habilita todo el catálogo de OpenAI: la lista de
  modelos que se muestre debe salir de `config.providers()` ya autenticado, no de una lista fija.

Los proveedores OAuth que todavía no implementamos (Claude Pro/Max, Copilot, xAI…) aparecen
visibles pero **deshabilitados** con la leyenda "próximamente": es información útil, no un bug.

En el paso 2, mostrar antes del redirect: *"Manteiner pide permiso de escritura de contenido
para poder crear la rama del PR. Nunca escribe en tu rama principal ni hace merge."*
Ver [03](./03-autenticacion-github.md).

### 3. Dashboard de repositorios

Una tarjeta por repo:

```
+--------------------------------------------------------------+
|  owner/repo                                  [ Auditar ]      |
|  TypeScript · main                                            |
|                                                               |
|  Ultima auditoria: hace 3 dias      Salud: 72/100             |
|  "Dependencias al dia, runtime de Lambda proximo a EOL"       |
|  4 hallazgos   ·   PR #128 abierto                            |
+--------------------------------------------------------------+
```

Si hay un run activo, la tarjeta muestra el paso actual en vivo (mismo `EventSource`).

### 4. Vista del run en vivo

Es la pantalla protagonista.

```
+---------------------------------------------------------------+
| owner/repo · Auditoria de mantenimiento        [ Cancelar ]   |
| Ejecutandose · 04:12 · anthropic/claude-sonnet-4-5            |
+---------------------------------------------------------------+
|                                                               |
|  [OK] Reconocimiento del repositorio                   0:22   |
|       Node 18, pnpm, Next.js 15, GitHub Actions               |
|                                                               |
|  [OK] Inventario de dependencias                       1:05   |
|       47 dependencias, 12 desactualizadas                     |
|                                                               |
|  [..] Investigacion de dependencias                           |
|       > consultando changelog de next@16                      |
|                                                               |
|  [  ] Actualizaciones seguras                                 |
|  [  ] Analisis de runtime y entorno                           |
|  [  ] Revision de mantenibilidad                              |
|  [  ] Elaboracion del informe                                 |
|                                                               |
+---------------------------------------------------------------+
```

Decisiones de UX — 🟡:

- Los 7 pasos se muestran **desde el principio**, en gris. El usuario ve el recorrido completo
  y cuánto falta. Mucho mejor que una lista que crece de a poco.
- La línea `>` muestra la herramienta en uso (`agent.tool`): es la señal de vida entre pasos.
- El texto del agente va en un panel colapsable ("ver razonamiento"), cerrado por defecto:
  informativo pero ruidoso.
- El cronómetro corre en el cliente desde `started_at`.
- Al terminar, la vista **muta** al informe sin recargar.

### 5. Informe del run

```
Cabecera:  Salud 72/100 · headline · fecha · modelo · duracion
Acciones:  [ Ver PR #128 ]  [ Descargar PDF ]  [ Ver diff ]  [ Volver a auditar ]

Tabs:
  Resumen        overview + tablas de dependencias aplicadas/diferidas
  Hallazgos      lista filtrable por severidad/categoria/esfuerzo
  Traza          los 7 pasos con su descripcion final
  Limitaciones   limitations + notas fuera de alcance
```

🟢 Los hallazgos con `confidence: "low"` llevan un distintivo visible. La app no debe
presentar todo con la misma autoridad: parte del valor es señalar de qué está menos segura.

### 6. Histórico del repo

Lista cronológica de runs con score, hallazgos y PR. 🟡 v1.1: gráfico de evolución del
`health_score` y vista de hallazgos persistentes.

### 7. Configuración

Credenciales de proveedor (con `lastFour` y estado), modelo por defecto, instalaciones de
GitHub, y borrado de cuenta.

## Estados vacíos y de error que hay que diseñar

No son un detalle: son la mayoría de lo que el usuario ve al principio.

| Situación | Qué mostrar |
|-----------|-------------|
| Sin repos vinculados | Onboarding, no una tabla vacía. |
| Repo sin runs | "Todavía no auditaste este repo" + botón. |
| Run fallido | Código de error traducido, qué se puede hacer, botón de reintento. |
| Credencial inválida | Banner persistente con link a configuración. |
| Refresh token OAuth vencido o revocado | "Tu conexión con ChatGPT expiró" + botón para rehacer el device flow. No hay recuperación automática. |
| Instalación revocada desde GitHub | Banner en el repo afectado + botón para reconectar. |
| Run sin hallazgos | "El repositorio está bien mantenido" — es un resultado válido, no un vacío. |
