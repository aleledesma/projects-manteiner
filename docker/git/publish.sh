#!/bin/sh
# Contenedor 3: publica los cambios del agente en una rama nueva (doc 05).
#
# Corre sobre un workspace que el agente tuvo en sus manos con `bash: allow`,
# asi que nada de `.git` se da por confiable: la config local se reescribe, los
# hooks se desactivan y la base del commit llega por argumento desde el host,
# no del archivo `/work/base_sha` que el agente pudo haber tocado.
set -eu

if [ "${MANTEINER_GIT_ASKPASS:-}" = "1" ]; then
  case "${1:-}" in
    *Username*) printf '%s\n' "x-access-token" ;;
    *Password*) cat "${MANTEINER_TOKEN_PIPE:?}" ;;
    *) exit 1 ;;
  esac
  exit 0
fi

if [ "$#" -lt 5 ]; then
  echo "usage: publish.sh OWNER REPOSITORY BASE_SHA HEAD_BRANCH PATHSPEC..." >&2
  exit 2
fi

OWNER="$1"
REPOSITORY="$2"
BASE_SHA="$3"
HEAD_BRANCH="$4"
shift 4
# Los argumentos restantes son pathspecs fijos de la app, nunca datos del agente.

case "$OWNER" in
  ""|*[!A-Za-z0-9-]*) echo "invalid owner" >&2; exit 2 ;;
esac
case "$REPOSITORY" in
  ""|.|..|*[!A-Za-z0-9._-]*) echo "invalid repository" >&2; exit 2 ;;
esac
case "$BASE_SHA" in
  *[!0-9a-f]*) echo "invalid base sha" >&2; exit 2 ;;
esac
[ "${#BASE_SHA}" -eq 40 ] || { echo "invalid base sha" >&2; exit 2; }
# Segunda barrera de assertPushTarget (doc 03): aunque el host fallara, este
# script se niega a pushear a cualquier rama fuera de `manteiner/`.
case "$HEAD_BRANCH" in
  manteiner/*) ;;
  *) echo "invalid push target" >&2; exit 3 ;;
esac
git check-ref-format --branch "$HEAD_BRANCH" >/dev/null 2>&1 || {
  echo "invalid branch" >&2
  exit 2
}
[ -n "${MANTEINER_COMMIT_MESSAGE:-}" ] || { echo "missing commit message" >&2; exit 2; }

IFS= read -r TOKEN || { echo "missing GitHub token" >&2; exit 2; }
[ -n "$TOKEN" ] || { echo "missing GitHub token" >&2; exit 2; }

cd /work/repo

# Config local limpia: un `url.*.insteadOf`, un `credential.helper` o un filtro
# plantado por el agente podria desviar el push o filtrar el token.
printf '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n' > .git/config
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_TERMINAL_PROMPT=0
GIT="git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c safe.directory=/work/repo"

# HEAD vuelve a la base conocida sin tocar el working tree: si el agente hizo
# commits propios, sus cambios quedan como modificaciones y pasan por el filtro.
$GIT reset -q "$BASE_SHA"
$GIT checkout -q -b "$HEAD_BRANCH"
$GIT add -A -- "$@"

if $GIT diff --cached --quiet; then
  printf '{"status":"no-changes"}\n'
  exit 0
fi

FILES_B64=$($GIT diff --cached --name-only | base64 | tr -d '\n')
$GIT -c user.name="Manteiner" -c user.email="bot@manteiner.local" \
  commit -q -m "$MANTEINER_COMMIT_MESSAGE"
COMMIT_SHA=$($GIT rev-parse HEAD)

umask 077
TOKEN_PIPE="/tmp/manteiner-token-$$"
WRITER_PID=""
cleanup() {
  if [ -n "$WRITER_PID" ]; then
    kill "$WRITER_PID" 2>/dev/null || true
    wait "$WRITER_PID" 2>/dev/null || true
  fi
  rm -f "$TOKEN_PIPE"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

mkfifo "$TOKEN_PIPE"
(printf '%s\n' "$TOKEN" > "$TOKEN_PIPE") &
WRITER_PID="$!"
unset TOKEN

# Sin `--force`: si la rama ya existe el push falla y no se pisa nada.
set +e
PUSH_OUTPUT=$(MANTEINER_GIT_ASKPASS=1 \
  MANTEINER_TOKEN_PIPE="$TOKEN_PIPE" \
  GIT_ASKPASS="$0" \
  $GIT push --porcelain "https://github.com/${OWNER}/${REPOSITORY}.git" \
  "HEAD:refs/heads/${HEAD_BRANCH}" 2>&1)
PUSH_STATUS=$?
set -e

if [ "$PUSH_STATUS" -ne 0 ]; then
  printf '%s\n' "$PUSH_OUTPUT" | sed 's/x-access-token:[^@]*@//g' >&2
  case "$PUSH_OUTPUT" in
    *"[rejected]"*|*"already exists"*|*"fetch first"*) exit 4 ;;
    *) exit 5 ;;
  esac
fi

printf '{"status":"pushed","commitSha":"%s","filesB64":"%s"}\n' "$COMMIT_SHA" "$FILES_B64"
