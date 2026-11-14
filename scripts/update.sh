#!/bin/sh
# -----------------------------------------------------------------------------
# NYSE Stock Portfolio Tracker: update a self-hosted install to a release tag.
#
# Manual by design (no auto-deploy): an administrator decides when to update.
# Fail-closed: if anything goes wrong, the previous version stays (or is put
# back) in service.
#
#   sudo nysetracker-update v0.5.0
#
# Steps
#   1. validate the tag name and that the tag exists (tags are never overwritten)
#   2. refuse to run over local changes in the app folder
#   3. back up the database (npm run backup)
#   4. checkout the tag, npm ci, build and run the test suite
#        failure -> reinstall the previous version; the app was never restarted
#   5. restart the service and wait for /api/health to report the new version
#        failure -> reinstall the previous version, restart it and report
#
# Settings (environment variables, all optional):
#   NYSE_SERVICE_USER   service account            (default: nysetracker)
#   NYSE_APP_DIR        app folder                 (default: /Users/<user>/app)
#   NYSE_LAUNCHD_LABEL  LaunchDaemon label         (default: local.nysetracker.app)
#   NYSE_PORT           local port of the app      (default: 3100)
#   NYSE_HEALTH_TIMEOUT seconds to wait for health (default: 60)
#   NYSE_RESTART_CMD    restart command            (default: launchctl kickstart -k system/<label>)
# -----------------------------------------------------------------------------
set -eu

TAG="${1:-}"
SERVICE_USER="${NYSE_SERVICE_USER:-nysetracker}"
APP_DIR="${NYSE_APP_DIR:-/Users/$SERVICE_USER/app}"
LABEL="${NYSE_LAUNCHD_LABEL:-local.nysetracker.app}"
PORT="${NYSE_PORT:-3100}"
HEALTH_URL="http://127.0.0.1:$PORT/api/health"
HEALTH_TIMEOUT="${NYSE_HEALTH_TIMEOUT:-60}"
RESTART_CMD="${NYSE_RESTART_CMD:-launchctl kickstart -k system/$LABEL}"

log() { printf '[update] %s\n' "$*"; }
fail() { printf '[update] ERRO: %s\n' "$*" >&2; exit 1; }

# Runs a command inside APP_DIR as the service user.
as_service() {
  if [ "$(id -un)" = "$SERVICE_USER" ]; then
    (cd "$APP_DIR" && sh -c "$1")
  else
    sudo -u "$SERVICE_USER" -H sh -c "cd \"$APP_DIR\" && $1"
  fi
}

# Version reported by /api/health; "legacy" for v0.4.x (no /api/health, but alive); empty if down.
running_version() {
  v="$(curl -fsS -m 3 "$HEALTH_URL" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  if [ -n "$v" ]; then
    printf '%s' "$v"
  elif curl -fsS -m 3 "http://127.0.0.1:$PORT/api/auth/me" >/dev/null 2>&1; then
    printf 'legacy'
  fi
}

# Waits until /api/health reports version $1 ("v" alone = any healthy version,
# used when the app was already down before the update).
wait_for_version() {
  want="$1"
  elapsed=0
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
    got="v$(running_version)"
    if [ "$got" != "v" ] && { [ "$want" = "v" ] || [ "$got" = "$want" ]; }; then return 0; fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

install_ref() { # $1 = tag or commit; $2 = "test" to also run the test suite
  cmd="git checkout --quiet \"$1\" && npm ci --no-audit --no-fund && npm run build"
  if [ "${2:-}" = "test" ]; then cmd="$cmd && npm test"; fi
  as_service "$cmd"
}

# --- 1. preconditions --------------------------------------------------------
printf '%s' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "informe a versão no formato vX.Y.Z (ex.: v0.5.0)"

if [ "$(id -u)" -ne 0 ] && [ "$(id -un)" != "$SERVICE_USER" ]; then
  fail "rode com sudo (ex.: sudo nysetracker-update $TAG)"
fi

as_service "test -d .git" || fail "pasta do app não encontrada: $APP_DIR"

log "buscando versões publicadas"
as_service "git fetch --tags --quiet" \
  || fail "não foi possível buscar as versões (rede, ou uma tag existente foi alterada no GitHub)"

as_service "git rev-parse -q --verify \"refs/tags/$TAG^{commit}\" >/dev/null" \
  || fail "a versão $TAG não existe"

as_service "git diff --quiet && git diff --cached --quiet" \
  || fail "há alterações locais na pasta do app; nada foi feito"

PREV="$(as_service "git describe --tags --exact-match 2>/dev/null || git rev-parse HEAD")"
if [ "$PREV" = "$TAG" ]; then
  log "já está na $TAG; nada a fazer"
  exit 0
fi
PREV_RUNNING="v$(running_version)"
[ "$PREV_RUNNING" = "v" ] && log "aviso: o app não está respondendo agora (seguindo mesmo assim)"
log "versão atual: $PREV (no ar: $PREV_RUNNING) -> nova: $TAG"

# --- 2. backup ---------------------------------------------------------------
log "backup do banco"
BACKUP_LINE="$(as_service "npm run --silent backup")" || fail "backup falhou; nada foi alterado"
log "$BACKUP_LINE"

# --- 3. install + tests (service still running the old version) -------------
log "instalando $TAG e rodando os testes"
if ! install_ref "$TAG" test; then
  log "instalação ou testes da $TAG falharam; reinstalando $PREV"
  install_ref "$PREV" || fail "não consegui reinstalar $PREV; veja docs/SELF_HOSTING.md (rollback manual)"
  fail "atualização abortada; o app continua na $PREV (não foi reiniciado)"
fi

# --- 4. restart + health -----------------------------------------------------
log "reiniciando o serviço"
sh -c "$RESTART_CMD"

if wait_for_version "$TAG"; then
  log "OK: $TAG no ar ($HEALTH_URL)"
  exit 0
fi

log "a $TAG não respondeu em ${HEALTH_TIMEOUT}s; voltando para $PREV"
install_ref "$PREV" || fail "não consegui reinstalar $PREV; veja docs/SELF_HOSTING.md (rollback manual)"
sh -c "$RESTART_CMD"
if wait_for_version "$PREV_RUNNING"; then
  fail "atualização desfeita; $PREV de volta no ar. Backup antes da tentativa: $BACKUP_LINE"
fi
fail "o app não voltou a responder; siga o rollback manual em docs/SELF_HOSTING.md. Backup: $BACKUP_LINE"
