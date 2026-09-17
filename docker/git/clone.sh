#!/bin/sh
set -eu

if [ "${MANTEINER_GIT_ASKPASS:-}" = "1" ]; then
  case "${1:-}" in
    *Username*) printf '%s\n' "x-access-token" ;;
    *Password*) cat "${MANTEINER_TOKEN_PIPE:?}" ;;
    *) exit 1 ;;
  esac
  exit 0
fi

if [ "$#" -ne 3 ]; then
  echo "usage: clone.sh OWNER REPOSITORY BRANCH" >&2
  exit 2
fi

OWNER="$1"
REPOSITORY="$2"
BRANCH="$3"

case "$OWNER" in
  ""|*[!A-Za-z0-9-]*) echo "invalid owner" >&2; exit 2 ;;
esac
case "$REPOSITORY" in
  ""|.|..|*[!A-Za-z0-9._-]*) echo "invalid repository" >&2; exit 2 ;;
esac
git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || {
  echo "invalid branch" >&2
  exit 2
}

if [ -e /work/repo ]; then
  echo "workspace is not empty" >&2
  exit 2
fi
rm -f /work/.volume-init

IFS= read -r TOKEN || {
  echo "missing GitHub token" >&2
  exit 2
}
if [ -z "$TOKEN" ]; then
  echo "missing GitHub token" >&2
  exit 2
fi

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

MANTEINER_GIT_ASKPASS=1 \
MANTEINER_TOKEN_PIPE="$TOKEN_PIPE" \
GIT_ASKPASS="$0" \
GIT_TERMINAL_PROMPT=0 \
git -c core.hooksPath=/dev/null \
  clone --depth 1 --single-branch --branch "$BRANCH" \
  "https://github.com/${OWNER}/${REPOSITORY}.git" /work/repo

if kill -0 "$WRITER_PID" 2>/dev/null; then
  kill "$WRITER_PID"
fi
wait "$WRITER_PID" 2>/dev/null || true
WRITER_PID=""
rm -f "$TOKEN_PIPE"

git -C /work/repo remote remove origin
git -C /work/repo config --unset-all http.extraHeader 2>/dev/null || true
git -C /work/repo rev-parse HEAD > /work/base_sha
du -sk /work/repo | awk '{print $1}' > /work/size_kb
printf '{"baseSha":"%s","sizeKb":%s}\n' "$(cat /work/base_sha)" "$(cat /work/size_kb)"
