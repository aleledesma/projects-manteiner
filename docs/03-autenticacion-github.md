# 03 — Autenticación y acceso a GitHub

Hay **dos integraciones distintas** con GitHub y conviene no mezclarlas:

| | Para qué | Mecanismo | Qué autoriza |
|---|---|---|---|
| **Login** | Identificar al usuario en la app | OAuth (authorization code) | `read:user`. **Cero acceso a repositorios.** |
| **Acceso a repos** | Leer código y crear PRs | **GitHub App** + installation token | Solo los repos que el usuario elija, uno por uno. |

> ⚠️ **Son dos autorizaciones separadas, no una.** Iniciar sesión con GitHub **no** le da a la
> app ningún acceso a los repositorios: solo identifica al usuario. El acceso llega en un
> segundo momento, cuando el usuario **instala la GitHub App** y elige explícitamente sobre
> qué repositorios. Son dos pantallas de consentimiento distintas de GitHub, en dos momentos
> distintos del onboarding ([09](./09-api-y-ui.md)).
>
> Se diseñó así a propósito: si el login pidiera acceso a repos, el usuario tendría que
> conceder permisos sobre su código solo para poder entrar y mirar la app.

🟢 Decisión: usar **GitHub App** para el acceso a repos, no un OAuth App con scope `repo`.

**Por qué.** Un OAuth App con scope `repo` obtiene acceso de escritura a *todos* los
repositorios del usuario, con un token que no expira. Una GitHub App permite que el
usuario elija **repositorio por repositorio**, con permisos granulares y tokens que
expiran en 1 hora. Para una app que va a clonar código ajeno y ejecutar un agente sobre
él, esa diferencia es el núcleo del modelo de seguridad.

## 1. Login del usuario (OAuth)

Flujo authorization code administrado por **Better Auth 1.6**:

```
1. POST /api/auth/sign-in/social { provider: "github", callbackURL: "..." }
   -> Better Auth genera `state` y PKCE, y persiste el estado temporal de un solo uso
   -> devuelve la URL de https://github.com/login/oauth/authorize

2. GET /api/auth/callback/github?code=...&state=...
   -> Better Auth valida `state` y PKCE
   -> intercambia el codigo y consulta /user + /user/emails
   -> crea/actualiza `users` y vincula `accounts` por el ID estable de GitHub
   -> hooks eliminan access/refresh/id token antes de escribir `accounts`
   -> crea `sessions`, firma la cookie y redirige a la web
```

Detalles que importan:

- 🟢 El login usa `read:user user:email`: Better Auth necesita un email estable para crear el
  usuario. **No** pide acceso a repos — eso lo da la GitHub App.
- 🟢 El `access_token` del OAuth de login **no se persiste**. Se usa una sola vez para
  leer el perfil y se descarta. La sesión de la app es propia.
- 🟢 Cookie de sesión: firmada, `httpOnly`, `secure` en producción y `sameSite=lax`.
- 🟢 `state` y PKCE obligatorios; el estado temporal se consume una sola vez.
- 🟢 `GET /api/me` expone el usuario y el estado del onboarding; el logout usa
  `POST /api/auth/sign-out`.

## 2. Acceso a repositorios (GitHub App)

### Permisos de la App — 🟢 decidido

| Permiso | Nivel | Por qué |
|---------|-------|---------|
| `metadata` | Read | Obligatorio; listar repos y su metadata. |
| `contents` | **Read & Write** | Leer el código *y* poder crear la rama del PR. |
| `pull_requests` | **Read & Write** | Crear el PR y su descripción. |

### Nota importante sobre "solo lectura + PRs"

La idea original era "permisos de solo lectura y a pull requests". **Eso no existe tal
cual en GitHub**: para abrir un PR desde una rama del mismo repositorio hace falta
`contents: write`, porque hay que crear la rama y el commit. Las alternativas reales son:

- **(A) `contents: write` + `pull_requests: write`** — lo estándar. Es lo que usan
  Dependabot y Renovate.
- **(B) Fork + PR cross-repo** — permite `contents: read` sobre el repo original, pero
  obliga a mantener forks, no funciona bien con repos privados de organizaciones y
  complica el UX.

🟢 Se elige **(A)**, compensando el permiso extra con dos controles:

1. **El token nunca entra al contenedor.** El agente no puede usarlo aunque quisiera.
   El push lo hace el orquestador en el host, sobre una rama nueva. Ver [05](./05-ejecucion-en-docker.md).
2. **La app nunca escribe sobre la rama por defecto.** El único destino permitido es
   `manteiner/<audit_type>/<runId-corto>`. Es una invariante del código, no una convención.

Esto se le debe comunicar al usuario en la pantalla de conexión: *"Manteiner necesita
permiso de escritura para poder crear la rama del PR. Nunca escribe sobre tu rama
principal y nunca hace merge."*

### Instalación

```
1. El usuario hace click en "Conectar repositorios"
2. -> https://github.com/apps/<app-slug>/installations/new?state=<state-firmado>
3. El usuario elige la cuenta y los repos (selected, no "all")
4. Callback: GET /api/github/setup?installation_id=...&setup_action=install&state=...
   -> valida state, asocia installation_id al user_id
   -> lista repos de la instalacion y los guarda en `repositories`
```

### Webhooks — 🟡 propuesto

Endpoint `POST /api/github/webhook` con verificación de firma `X-Hub-Signature-256` (HMAC SHA-256, comparación en tiempo constante).

Eventos a manejar en v1:

| Evento | Acción |
|--------|--------|
| `installation.deleted` | Marcar la instalación y sus repos como desvinculados. |
| `installation_repositories.added/removed` | Sincronizar `repositories`. |
| `installation.suspend/unsuspend` | Setear `suspended_at`. |

Si preferís empezar sin webhooks, la alternativa es re-sincronizar los repos en cada
carga del dashboard. Funciona, pero deja estado obsoleto si alguien revoca desde GitHub.

### Generación de installation tokens

```
1. Firmar un JWT con la private key de la App (RS256, exp <= 10 min, iss = app_id)
2. POST /app/installations/<installation_id>/access_tokens
   body opcional: { repositories: ["mi-repo"], permissions: { contents: "write", pull_requests: "write" } }
   -> { token, expires_at }   (~1 hora)
```

🟢 Usar **siempre** el body opcional para reducir el scope del token a *ese único
repositorio* y a los permisos mínimos de la operación. Un token de instalación sin
restringir puede tocar todos los repos de la instalación.

🟢 El token se genera al inicio del run, se usa para clonar y para crear el PR, y **no se
persiste**. Si el run dura más de una hora se regenera antes del push.

🟡 Cachear el token en memoria por `installation_id + repo` con TTL de 50 minutos.

### Dónde se usa el token

🟢 **El token nunca se usa en el host ni entra al contenedor del agente.** Se entrega por
**stdin** a dos contenedores auxiliares de vida muy corta —el de clonado y el de publicación—
que corren nuestra imagen `manteiner-git`: sin Node, sin opencode, sin LLM. Los detalles
mecánicos (por qué stdin y no variables de entorno, `core.hooksPath=/dev/null`, limpieza del
remote tras clonar) están en [05](./05-ejecucion-en-docker.md).

Lo relevante desde el lado de GitHub:

- Se usa `http.extraHeader` en vez de poner el token en la URL: así no queda en `.git/config`,
  ni en el reflog, ni en la línea de comandos de ningún proceso.
- Tras clonar se borra el remote, de modo que cuando el contenedor del agente monta el
  volumen no hay ni URL de origen ni credencial que encontrar.
- Para publicar se pide un token **nuevo**: el del clon puede haber expirado si el run fue largo.

### Creación del PR

El `push` lo hace el contenedor de publicación; el PR en sí es una llamada HTTP que hace el
orquestador, que no necesita el repositorio:

```
1. GET /repos/{owner}/{repo}/git/ref/heads/{base}          -> sha base
2. POST /repos/{owner}/{repo}/git/refs                      -> crea manteiner/maintenance/<runId>
3. Para cada archivo cambiado:
     POST /repos/{owner}/{repo}/git/blobs
4. POST /repos/{owner}/{repo}/git/trees                     -> arbol con base_tree
5. POST /repos/{owner}/{repo}/git/commits                   -> commit
6. PATCH /repos/{owner}/{repo}/git/refs/heads/<rama>        -> apunta la rama al commit
7. POST /repos/{owner}/{repo}/pulls                         -> abre el PR
```

🟢 **Decisión (A3, revisada): `git push` desde el contenedor de publicación + paso 7 por API.**
Los pasos 1-6 de arriba (blobs/trees/commits por API) existirían para controlar qué archivos
entran al commit, pero ese control ya lo ejercemos antes, filtrando el working tree contra la
allowlist. Hacerlo dos veces sería redundante, y la API de Git exigiría sacar el contenido de
los archivos del volumen hacia el host — exactamente lo que este diseño evita.

Queda entonces: el contenedor de publicación crea la rama, filtra, commitea y pushea; el
orquestador solo hace el `POST /pulls`.

### Por qué no puede haber un push a la rama principal

Conviene ser preciso, porque es fácil creer que esto lo garantiza GitHub y **no es así**:

- ❌ **GitHub no lo impide.** El installation token tiene `contents: write` sobre el repo.
  Si nuestro código ejecutara `git push origin main`, GitHub lo aceptaría.
- ✅ **Lo impide nuestro código**, con tres barreras:
  1. **El nombre de la rama nunca es un dato de entrada.** Se computa como
     `manteiner/${auditType}/${runId.slice(0,8)}` a partir de valores que genera la app. Ni
     el agente ni el usuario ni el repositorio pueden influir en él.
  2. **Hay un único lugar en todo el código que hace `push`**, y recibe el nombre de la rama
     como argumento ya computado. No existe otra ruta de escritura hacia GitHub.
  3. **Aserción dura antes de ejecutar el push**, que falla el run si no se cumple:

```ts
function assertPushTarget(branch: string, defaultBranch: string) {
  if (!branch.startsWith("manteiner/")) throw new Error("INVALID_PUSH_TARGET");
  if (branch === defaultBranch)         throw new Error("INVALID_PUSH_TARGET");
}
```

Dicho de otro modo: **la garantía es una invariante que mantenemos nosotros, no una
restricción que nos impone la plataforma.** Por eso la aserción y el punto único de escritura
son parte del diseño y no un detalle de implementación: son lo que sostiene la afirmación.

Un usuario que quiera una garantía del lado de GitHub puede además activar **branch
protection** en su rama principal. Es buena práctica recomendarlo en la UI, pero la app no
puede depender de eso.

Reglas del PR — 🟢:

- Rama siempre `manteiner/<audit_type>/<runId-corto>`. Si existe, se aborta (no se fuerza).
- Base = rama por defecto del repo. Nunca se hace merge automático.
- El cuerpo del PR lo escribe el agente (`proposed_pull_request.body`) y la app le agrega
  un pie con el link al run y la nota de que fue generado por IA.
- Se verifica que el diff toque **solo** archivos de manifiesto/lockfile permitidos
  (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements.txt`,
  `go.mod`, `go.sum`, `Cargo.toml`, `Cargo.lock`, ...). Si el agente modificó código fuente,
  **se descarta ese cambio** y se anota como limitación. Ver [10](./10-seguridad.md).

## Errores a manejar explícitamente

| Situación | Respuesta |
|-----------|-----------|
| Instalación suspendida o borrada | Run falla con `GITHUB_INSTALLATION_UNAVAILABLE`, se pide reconectar. |
| Repo archivado o sin permiso de escritura | Se corre la auditoría igual, se saltea el PR, se anota en limitaciones. |
| Rate limit (403/429 con `x-ratelimit-remaining: 0`) | Backoff con `x-ratelimit-reset`; el run espera o falla con mensaje claro. |
| Rama ya existente | `PR_BRANCH_EXISTS`, no se pisa. |
| Repo vacío (sin commits) | Se aborta antes de lanzar el contenedor. |
