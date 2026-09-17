# 05 — Ejecución en contenedores efímeros

> **Revisión 3.** La v1 clonaba el repositorio en el filesystem del host y lo borraba al
> terminar; se descartó. La v2 lo ponía en un volumen tmpfs (RAM); se cambió por consumo
> excesivo de memoria en repos grandes. Ver [12](./12-decisiones-abiertas.md), R1 y R1b.

## Las dos restricciones que tenemos que satisfacer a la vez

1. **El agente no puede tener credenciales de GitHub.** Lee código no confiable; si un
   README lo manipula, no debe haber nada que robar ni con qué pushear.
2. **El repositorio no puede vivir en el filesystem de la aplicación.** Ni siquiera
   temporalmente "y después se borra". Debe morir con la infraestructura efímera del run,
   sin depender de que nos acordemos de limpiarlo.

Un solo contenedor no puede satisfacer las dos: si el contenedor clona, tiene el token
(rompe 1); si la app clona, el repo aparece en su filesystem (rompe 2).

**La solución es separar en el tiempo, no en el espacio:** tres contenedores secuenciales
que comparten un volumen efímero, donde solo el primero y el último ven el token, y el del
medio —el único que ejecuta un LLM— no lo ve nunca.

## Arquitectura: tres contenedores, un volumen efímero

```
                     volumen efimero de Docker (por run)
                    +--------------------------------------+
                    |            /work/repo                |
                    +--------------------------------------+
                       ^              ^               ^
                       |              |               |
        +--------------+---+  +-------+--------+  +---+-------------+
   (1)  | manteiner-git    |  | manteiner-agent|  | manteiner-git   | (3)
        | cmd: clone       |  | opencode serve |  | cmd: publish    |
        |                  |  |                |  |                 |
        | TOKEN por stdin  |  |   SIN TOKEN    |  | TOKEN por stdin |
        | sin LLM          |  |   con LLM      |  | sin LLM         |
        +------------------+  +----------------+  +-----------------+
             clona                 audita             valida + push + PR
             y limpia                                 
                    +--------------------------------------+
                    |   docker volume rm  -> no queda nada  |
                    +--------------------------------------+
```

🟢 **La propiedad clave:** el token y el LLM nunca coexisten en el mismo contenedor.
No es una regla de configuración, es una imposibilidad estructural.

🟢 **La aplicación nunca escribe el repositorio en su filesystem.** Lo único que cruza al
proceso de la API es texto: el JSON del informe y la salida de `git diff`, ambos en memoria.

### El volumen

🟢 **Por defecto: volumen local de Docker, en su disco virtual** (`WORKSPACE_BACKEND=disk`).

```bash
docker volume create --driver local manteiner-ws-<runId>
```

El volumen vive en el área de datos de Docker (`/var/lib/docker/volumes/...`, que en Windows
está dentro del `ext4.vhdx` de WSL2, **no** en el filesystem de Windows). Se destruye con
`docker volume rm` al terminar el run.

#### Por qué un volumen de Docker sigue cumpliendo el requisito

El requisito era que el repositorio no se clone en la máquina "y después se borre". Un volumen
de Docker no es eso:

| | Directorio en el host (rechazado) | Volumen de Docker |
|---|---|---|
| Aparece en el árbol del proyecto | Sí | No |
| El proceso de la API puede leerlo | Sí, es una ruta común | No: está dentro de la VM de Docker |
| Requiere que "nos acordemos" de borrar | Sí, un `rm -rf` que puede fallar | No: es una entidad de Docker con ciclo de vida propio |
| Vive y muere con la infraestructura del run | No | Sí |

🟢 El repositorio nunca existe como archivos accesibles para la aplicación. Solo lo ven los
contenedores a los que se lo montamos explícitamente.

#### Lo que se pierde respecto a tmpfs, y por qué se acepta

Al escribirse en disco, tras `docker volume rm` los bloques quedan desasignados pero no
necesariamente sobreescritos: en teoría son recuperables con análisis forense del disco
virtual hasta que se reutilicen.

🟢 **Se acepta.** Quien tenga acceso al disco de la VM de Docker ya tiene la base SQLite y la
`MASTER_KEY` del entorno del proceso. El riesgo marginal es bajo frente a lo que esa persona
ya obtendría por otras vías.

#### Modo tmpfs — opt-in

```bash
docker volume create --driver local \
  --opt type=tmpfs --opt device=tmpfs \
  --opt o=size=2g,uid=10001,mode=0700 \
  manteiner-ws-<runId>
```

🟡 `WORKSPACE_BACKEND=tmpfs` respalda el volumen en RAM: el clon no toca ningún disco en
ningún momento. Queda disponible para quien necesite esa garantía sobre repositorios chicos,
al costo de `MAX_CONCURRENT_RUNS × WORKSPACE_SIZE` de RAM.

Por qué un *volumen* y no un `--tmpfs` del contenedor, en ambos modos: los tres contenedores
corren en secuencia y necesitan ver el mismo contenido. Un `--tmpfs` muere con cada contenedor;
un volumen sobrevive entre ellos y se destruye cuando nosotros decimos.

#### Control de tamaño: chequeo previo, no tope duro

⚠️ Los volúmenes locales de Docker **no soportan límite de tamaño**. Con `disk` perdemos el
tope duro que daba el `size=` del tmpfs, así que un repo enorme podría llenar el disco de la VM.

🟢 Se reemplaza por un chequeo barato **antes** de clonar: la API de GitHub devuelve el tamaño
del repositorio en KB al consultarlo.

```ts
const { size } = await github.getRepo(owner, name);   // KB
if (size > MAX_REPO_SIZE_KB) throw new RunError("WORKSPACE_TOO_LARGE");
```

Mejor fallar en `preparing` con un mensaje claro que descubrirlo con el disco lleno a mitad de
un clon. `MAX_REPO_SIZE_KB` por defecto 🟡 `2_000_000` (~2 GB); `--depth 1` hace que el clon
real sea bastante menor que ese número.

⚠️ **Nota operativa sobre WSL2:** el `ext4.vhdx` crece hasta el pico histórico de uso y **no se
achica solo** aunque borremos cada volumen. No es un problema de correctitud, pero conviene
saberlo y compactarlo de vez en cuando (`docker system prune` no alcanza: hay que compactar el
VHDX).

## Contenedor 1 — clone

Imagen `manteiner-git`: Alpine 3.22 + `git` + `ca-certificates`, ejecutada como UID/GID 10001.
Sin Node, sin opencode, sin LLM. Chica y auditable.

### El token entra por stdin, no por env

```js
const c = await docker.createContainer({
  name: `manteiner-clone-${runId}`,
  Image: GIT_IMAGE,
  Cmd: ["/usr/local/bin/clone.sh", owner, repo, branch],
  OpenStdin: true,
  StdinOnce: true,
  HostConfig: {
    Mounts: [{ Type: "volume", Source: volumeName, Target: "/work" }],
    CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
    Memory: 1024 ** 3, NanoCpus: 1e9, PidsLimit: 128,
  },
});

const stream = await c.attach({ stream: true, stdin: true, stdout: true, stderr: true });
await c.start();
stream.write(token + "\n");   // el token viaja por stdin
stream.end();

const { StatusCode } = await c.wait();
// StdinOnce puede cerrar el attach antes que stdout: el resultado final se lee con c.logs().
```

🟢 **Por qué stdin y no `Env`.** Las variables de entorno aparecen en `docker inspect`, en
`/proc/<pid>/environ` y en cualquier volcado del estado del contenedor. Stdin se consume una
vez y no queda en ninguna estructura persistente de Docker.

### `clone.sh`

```sh
#!/bin/sh
set -eu

if [ "${MANTEINER_GIT_ASKPASS:-}" = "1" ]; then
  case "${1:-}" in
    *Username*) printf '%s\n' "x-access-token" ;;
    *Password*) cat "${MANTEINER_TOKEN_PIPE:?}" ;;
  esac
  exit 0
fi

OWNER="$1"; REPO="$2"; BRANCH="$3"
read -r TOKEN                      # del stdin, una sola vez

# El script entra en modo askpass cuando Git pide usuario o password. El token
# viaja por un FIFO con permisos 0600, no por argumentos ni por el entorno.
TOKEN_PIPE="/tmp/manteiner-token-$$"
mkfifo "$TOKEN_PIPE"
(printf '%s\n' "$TOKEN" > "$TOKEN_PIPE") &
unset TOKEN

MANTEINER_GIT_ASKPASS=1 MANTEINER_TOKEN_PIPE="$TOKEN_PIPE" \
  GIT_ASKPASS="$0" GIT_TERMINAL_PROMPT=0 \
  git -c core.hooksPath=/dev/null \
    clone --depth 1 --single-branch --branch "$BRANCH" \
    "https://github.com/${OWNER}/${REPO}.git" /work/repo

# borrar todo rastro de credencial y de origen remoto
git -C /work/repo remote remove origin
git -C /work/repo config --unset-all http.extraHeader 2>/dev/null || true

git -C /work/repo rev-parse HEAD > /work/base_sha
du -sk /work/repo | cut -f1        > /work/size_kb
```

- `--depth 1 --single-branch`: solo lo necesario. Menos espacio, menos tiempo.
- `core.hooksPath=/dev/null`: git no ejecuta hooks del repositorio clonado. Barato y cierra
  un vector de ejecución de código.
- `GIT_ASKPASS` entrega el token desde el FIFO solo si Git lo solicita. No aparece en
  `docker inspect`, `/proc/<pid>/environ` ni `/proc/<pid>/cmdline`.
- Se borra el remote: cuando el contenedor 2 monte el volumen, no hay ni URL ni credencial.
- `base_sha` queda registrado para el run. **No hace falta un commit artificial**: el clon ya
  tiene un HEAD limpio, así que el `git diff` posterior muestra exactamente lo que tocó el agente.

🟢 Si el contenedor sale con código ≠ 0, el run falla en `cloning` y el volumen se destruye.

🟢 La implementación vive en `RepositoryWorkspaceService.withClonedRepository()`: entrega el
volumen a un callback para que los siguientes contenedores lo usen y lo elimina en `finally`,
incluso si falla el clon o el callback.

## Contenedor 2 — agent

El que hace el trabajo. **No tiene token, no tiene red hacia GitHub como cliente autenticado,
no puede pushear.**

```js
const c = await docker.createContainer({
  name: `manteiner-agent-${runId}`,
  Image: AGENT_IMAGE,
  Labels: { "manteiner.run": runId, "manteiner.user": userId },
  Env: [
    `MANTEINER_RUN_ID=${runId}`,
    `MANTEINER_MODEL=${providerId}/${modelId}`,
    `OPENCODE_SERVER_PASSWORD=${runPassword}`,   // aleatorio, 32 bytes, unico por run
  ],
  WorkingDir: "/work/repo",
  ExposedPorts: { "4096/tcp": {} },
  HostConfig: {
    Mounts: [{ Type: "volume", Source: volumeName, Target: "/work" }],
    PortBindings: { "4096/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
    Tmpfs: { "/tmp": "rw,noexec,nosuid,size=256m" },

    Memory: 2 * 1024 ** 3,
    MemorySwap: 2 * 1024 ** 3,
    NanoCpus: 2 * 1e9,
    PidsLimit: 512,
    Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 8192 }],

    Privileged: false,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    AutoRemove: false,
  },
});
```

Notas:

- **Puerto efímero en loopback** (`HostPort: "0"` + `HostIp: "127.0.0.1"`): el servidor de
  opencode solo es alcanzable desde el host. El puerto real se lee con `container.inspect()`.
- **`OPENCODE_SERVER_PASSWORD`**: basic auth distinta por run. Aunque el puerto sea loopback,
  ningún otro proceso local puede hablarle al agente.
- **`CapDrop: ["ALL"]` + `no-new-privileges`**: el agente no necesita ninguna capability.
- **Sin `/var/run/docker.sock`**: innegociable. Montarlo equivale a dar root en el host.
- **`AutoRemove: false`**: necesitamos leer el estado de salida y los logs antes de borrar.

### La imagen del agente

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION
RUN npm install -g opencode-ai@${OPENCODE_VERSION}

RUN useradd --create-home --uid 10001 agent
WORKDIR /work
COPY --chown=agent:agent runner/ /opt/runner/
RUN cd /opt/runner && npm ci --omit=dev

USER agent
ENV HOME=/home/agent
ENTRYPOINT ["node", "/opt/runner/index.js"]
```

🟢 Versión de opencode **pinneada** y guardada en `runs.agent_version`. Sin eso, el histórico
deja de ser interpretable cuando opencode cambie de comportamiento.

🟡 v1 apunta a repos Node/JS/TS. Otros ecosistemas: imágenes por ecosistema, más adelante.

### El runner

```
1. Leer MANTEINER_* del entorno.
2. Escribir /work/repo/.opencode/opencode.json      (config de [04])
   y      /work/repo/.opencode/agents/maintainer.md (prompt de [06])
3. Ejecutar `opencode serve --hostname 0.0.0.0 --port 4096`
4. Reenviar SIGTERM al hijo para que `docker stop` sea limpio.
```

🟢 El runner **no dirige la sesión**. La dirige el orquestador desde el host, donde el prompt,
el JSON Schema y la lógica de reintentos son fáciles de versionar y testear. El contenedor es
una caja tonta que expone opencode.

### Red

El contenedor **necesita salida a internet**: la API del proveedor de IA, el registry de npm y
las páginas que consulte para investigar. No se puede usar `NetworkMode: "none"`.

Para el proveedor OAuth de OpenAI los destinos son `auth.openai.com` y
`chatgpt.com/backend-api/codex/*` — no `api.openai.com`. Relevante para el futuro proxy de
egress con allowlist ([10](./10-seguridad.md)).

## Contenedor 3 — publish

Misma imagen que el 1. Recibe un token **fresco** (el del clon puede haber expirado si el run
fue largo) y la allowlist de archivos permitidos.

```sh
#!/bin/sh
set -eu
OWNER="$1"; REPO="$2"; BASE="$3"; HEAD_BRANCH="$4"; shift 4
# Los argumentos restantes son pathspecs fijos de la app, nunca datos del agente.
[ "$#" -gt 0 ] || { echo "missing-allowlist" >&2; exit 2; }
read -r TOKEN

cd /work/repo
git -c core.hooksPath=/dev/null checkout -b "$HEAD_BRANCH"

# Stagear solo archivos permitidos. Después, restaurar cambios tracked no
# stageados y borrar untracked no permitidos. Esto también maneja archivos
# nuevos y nombres con espacios sin parsear la salida de git.
git add -A -- "$@"
git restore --worktree .
git clean -fd

git diff --cached --quiet && { echo "no-changes"; exit 0; }

git -c user.name="Manteiner" -c user.email="bot@manteiner.local" \
    -c core.hooksPath=/dev/null commit -m "$(cat /work/commit_msg)"

AUTH=$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)
git -c http.extraHeader="Authorization: Basic ${AUTH}" \
    push "https://github.com/${OWNER}/${REPO}.git" "$HEAD_BRANCH"
```

El push usa una URL explícita: `clone.sh` elimina `origin` antes de que el agente vea el
workspace, y el contenedor de publicación no vuelve a persistirlo en `.git/config`.

🟢 **El `git push` tiene el nombre de la rama como argumento, calculado por el orquestador.**
El agente no interviene en ese valor. Ver [03](./03-autenticacion-github.md) para la
invariante de que nunca se pushea a la rama por defecto.

🟢 La validación de la allowlist corre acá, en **nuestra** imagen: sin LLM, sin código del
repositorio ejecutándose, con hooks desactivados. Es código nuestro, igual de confiable que
el host, y evita tener que sacar el repo del volumen.

El orquestador obtiene el diff para el informe y para el registro leyendo la salida de un
`exec`, no montando nada:

```js
const diff = await execCapture(container, ["git", "-C", "/work/repo", "diff"]);
// texto en memoria, se descarta al terminar
```

El PR propiamente dicho lo crea el orquestador con la API de GitHub (paso 7 de [03](./03-autenticacion-github.md)),
que es una sola llamada HTTP y no necesita el repositorio.

## Secuencia completa

```js
const volume = await docker.createVolume(workspaceVolumeSpec(runId));  // disk | tmpfs
try {
  // (1) clonar
  const { baseSha } = await runCloneContainer({ volume, owner, repo, branch, token });

  // (2) auditar
  const { report, session } = await runAgentContainer({ volume, providerCred, model, runId });

  // (3) publicar, si hay cambios
  const diff = await getDiff(volume);
  if (diff) await runPublishContainer({ volume, owner, repo, branch, headBranch, token: fresh() });
  const pr = diff ? await github.createPullRequest({...}) : null;

} finally {
  await removeAllContainers(runId);      // los tres, force
  await docker.getVolume(volumeName).remove({ force: true });   // <- el repo deja de existir
}
```

🟢 El `finally` es innegociable: el volumen se destruye **siempre**, haya terminado bien, mal,
por timeout o por cancelación.

## Timeouts y cancelación

| Nivel | Valor 🟡 | Qué hace |
|-------|----------|----------|
| Clon | 5 min | `CLONE_TIMEOUT`. |
| Healthcheck de opencode | 60 s | `CONTAINER_START_TIMEOUT`. |
| Ejecución del agente | 30 min (`RUN_TIMEOUT_MS`) | `session.abort()` → `docker stop` → `timed_out`. |
| Publicación | 3 min | `PUBLISH_TIMEOUT`. |
| `docker stop` | 10 s de gracia | Después, `SIGKILL`. |
| Cancelación del usuario | inmediata | Mismo camino, estado `cancelled`. |

🟢 El timeout aplica al **wall clock total del run**, no solo al prompt: un agente que entra
en bucle de herramientas sin devolver respuesta igual muere.

## Fallos y sus códigos

| `error_code` | Causa |
|--------------|-------|
| `DOCKER_UNAVAILABLE` | No hay daemon o no hay permisos sobre el socket. |
| `IMAGE_MISSING` | Falta `manteiner-git` o `manteiner-agent`. |
| `CLONE_FAILED` | Repo inexistente, sin permisos, rama inexistente. |
| `WORKSPACE_TOO_LARGE` | El repo supera `MAX_REPO_SIZE_KB` (chequeo previo al clon). |
| `CONTAINER_START_TIMEOUT` | opencode no respondió el healthcheck. |
| `CONTAINER_OOM` | `State.OOMKilled === true`. |
| `PROVIDER_AUTH_FAILED` | Credencial inválida, revocada o refresh vencido. |
| `PROVIDER_RATE_LIMIT` | 429 del proveedor. |
| `SCHEMA_INVALID` | El JSON no valida tras los reintentos. |
| `PR_BRANCH_EXISTS` | La rama destino ya existe; no se pisa. |
| `RUN_TIMEOUT` | Excedió `RUN_TIMEOUT_MS`. |

## Qué queda en el host al terminar un run

Vale enumerarlo explícitamente, porque es el punto de todo este diseño:

| Queda | No queda |
|-------|----------|
| Fila en `runs` con el informe JSON validado | El código fuente del repositorio |
| `run_steps`, `run_findings`, `run_events` | El clon, ni completo ni parcial |
| El PDF en `ARTIFACTS_DIR` | El `.git`, el índice, los objetos |
| El `pr_url` | El diff en disco (solo pasó por memoria) |
| Log del contenedor **solo si el run falló** | Ningún token de GitHub (nunca se persisten) |

🟡 El artefacto `patch` queda **desactivado por defecto** (`STORE_PATCH_ARTIFACT=false`): el PR
ya es el registro canónico del diff, y guardar el patch duplicaría fragmentos de código del
usuario en nuestro disco. Se puede activar para depuración.

⚠️ Excepción consciente: los logs del contenedor de un run fallido **pueden contener fragmentos
de código** del repositorio. Se guardan solo en runs fallidos, se borran junto con el run, y
conviene que la UI lo diga al ofrecer la descarga.

## Limpieza al arrancar la API

```js
await db.markOrphanRunsFailed("SERVER_RESTART");

for (const c of await docker.listContainers({ all: true, filters: { label: ["manteiner.run"] } }))
  await docker.getContainer(c.Id).remove({ force: true });

for (const v of await docker.listVolumes({ filters: { name: ["manteiner-ws-"] } }))
  await docker.getVolume(v.Name).remove({ force: true });
```

## Nota sobre Windows

Docker Desktop expone el daemon en `//./pipe/docker_engine`:
`new Docker({ socketPath: '//./pipe/docker_engine' })`.

🟢 **Este diseño elimina el problema de rendimiento que tenía la v1 en Windows.** Ya no hay
bind mounts de rutas de Windows hacia contenedores Linux: el volumen vive enteramente dentro
de la VM de Docker. El clon corre a velocidad nativa de Linux.

El volumen vive en el disco de la VM de Docker Desktop, así que hay que darle espacio
suficiente en Settings → Resources. Si se usa `WORKSPACE_BACKEND=tmpfs`, lo que hay que
dimensionar es la **RAM** de la VM, acorde a `MAX_CONCURRENT_RUNS × WORKSPACE_SIZE`.
