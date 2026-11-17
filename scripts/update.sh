#!/bin/sh
# -----------------------------------------------------------------------------
# Dodopo Asset Manager: update a self-hosted install to a release tag.
#
# Manual by design (no auto-deploy): an administrator decides when to update.
# Fail-closed: if anything goes wrong, the previous version stays (or is put
# back) in service.
#
#   sudo dodopoam-update v0.12.0
#
# Steps
#   1. validate the tag name and that the tag exists (tags are never overwritten)
#   2. refuse to run over local changes in the app folder
#   3. back up the database (npm run backup)
#   4. checkout the tag, npm ci, build and run the test suite
#        failure -> reinstall the previous version; the app was never restarted
#   5. back up the database again (right before the restart), restart the
#      service and wait for /api/health to report the new version
#        failure -> reinstall the previous version, put back the database from
#        that last backup (the new version may have migrated it; the failed
#        database is kept aside, never deleted), start it and report
#
# Settings (environment variables, all optional):
#   DAM_SERVICE_USER   service account            (default: dodopoam)
#   DAM_APP_DIR        app folder                 (default: /Users/<user>/app)
#   DAM_LAUNCHD_LABEL  LaunchDaemon label         (default: local.dodopoam.app)
#   DAM_PORT           local port of the app      (default: 3100)
#   DAM_HEALTH_TIMEOUT seconds to wait for health (default: 60)
#   DAM_RESTART_CMD    restart command            (default: launchctl kickstart -k system/<label>)
#   DAM_STOP_CMD       stop command (rollback)    (default: launchctl bootout system/<label>)
#   DAM_START_CMD      start command (rollback)   (default: launchctl bootstrap system /Library/LaunchDaemons/<label>.plist)
# The old NYSE_* names (before v0.12.0) are still accepted.
# -----------------------------------------------------------------------------
set -eu

TAG="${1:-}"
SERVICE_USER="${DAM_SERVICE_USER:-${NYSE_SERVICE_USER:-dodopoam}}"
APP_DIR="${DAM_APP_DIR:-${NYSE_APP_DIR:-/Users/$SERVICE_USER/app}}"
LABEL="${DAM_LAUNCHD_LABEL:-${NYSE_LAUNCHD_LABEL:-local.dodopoam.app}}"
PORT="${DAM_PORT:-${NYSE_PORT:-3100}}"
HEALTH_URL="http://127.0.0.1:$PORT/api/health"
HEALTH_TIMEOUT="${DAM_HEALTH_TIMEOUT:-${NYSE_HEALTH_TIMEOUT:-60}}"
RESTART_CMD="${DAM_RESTART_CMD:-${NYSE_RESTART_CMD:-launchctl kickstart -k system/$LABEL}}"
STOP_CMD="${DAM_STOP_CMD:-${NYSE_STOP_CMD:-launchctl bootout system/$LABEL}}"
START_CMD="${DAM_START_CMD:-${NYSE_START_CMD:-launchctl bootstrap system /Library/LaunchDaemons/$LABEL.plist}}"

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

# Path in a "[backup] <time> ok <file>" line printed by npm run backup.
backup_file() { printf '%s' "$1" | sed -n 's/^\[backup\] [^ ]* ok \(.*\)$/\1/p'; }

# Stops the service and waits until it no longer answers (or times out).
stop_service() {
  sh -c "$STOP_CMD" >/dev/null 2>&1 || true
  waited=0
  while [ -n "$(running_version)" ] && [ "$waited" -lt 20 ]; do
    sleep 1
    waited=$((waited + 1))
  done
}

# Starts the service, retrying (launchd may refuse a bootstrap right after a bootout).
start_service() {
  for attempt in 1 2 3 4 5; do
    if sh -c "$START_CMD" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# Puts the database back from $RESTORE_FILE into $DB_FILE with the service
# stopped. The copy is made and checked BEFORE anything is moved; the current
# files are renamed to *.falhou-<time>, never deleted, and moved back if the
# swap fails. Never leaves the database file missing.
restore_database() {
  [ -n "${RESTORE_FILE:-}" ] && [ -n "${DB_FILE:-}" ] || return 1
  stamp="$(date +%Y%m%d-%H%M%S)"
  staged="$DB_FILE.restaurando-$stamp"
  as_service "umask 077 && cp \"$RESTORE_FILE\" \"$staged\" && cmp -s \"$RESTORE_FILE\" \"$staged\"" || {
    as_service "rm -f \"$staged\"" || true
    log "não consegui preparar a cópia do backup (disco cheio?); o banco atual não foi tocado"
    return 1
  }
  stop_service
  if as_service "for f in \"$DB_FILE\" \"$DB_FILE-wal\" \"$DB_FILE-shm\"; do if [ -f \"\$f\" ]; then mv \"\$f\" \"\$f.falhou-$stamp\"; fi; done && mv \"$staged\" \"$DB_FILE\" && cmp -s \"$RESTORE_FILE\" \"$DB_FILE\""; then
    log "banco restaurado de $RESTORE_FILE (o banco da tentativa ficou em $DB_FILE.falhou-$stamp)"
    return 0
  fi
  # Swap failed: put the previous files back exactly as they were.
  as_service "rm -f \"$staged\"; for f in \"$DB_FILE\" \"$DB_FILE-wal\" \"$DB_FILE-shm\"; do if [ -f \"\$f.falhou-$stamp\" ]; then mv -f \"\$f.falhou-$stamp\" \"\$f\"; fi; done" || true
  log "não consegui trocar o banco; os arquivos anteriores foram devolvidos"
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
  fail "rode com sudo (ex.: sudo dodopoam-update $TAG)"
fi

as_service "test -d .git" || fail "pasta do app não encontrada: $APP_DIR"

log "buscando versões publicadas"
as_service "git fetch --tags --quiet" \
  || fail "não foi possível buscar as versões (rede, ou uma tag existente foi alterada no GitHub)"

as_service "git rev-parse -q --verify \"refs/tags/$TAG^{commit}\" >/dev/null" \
  || fail "a versão $TAG não existe"

as_service "git diff --quiet && git diff --cached --quiet" \
  || fail "há alterações locais na pasta do app; nada foi feito"

# This command must be the one published with the version being installed:
# a newer version may need a newer rollback (e.g. restoring the database).
if ! as_service "git show \"$TAG:scripts/update.sh\"" 2>/dev/null | cmp -s - "$0"; then
  fail "o comando de atualização da $TAG é diferente deste; reinstale-o antes (docs/SELF_HOSTING.md, \"Atualizar para uma nova versão\"). Nada foi feito"
fi

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
# A fresh backup right before the restart: the one to restore if the new
# version fails (it may migrate the database when it starts). The database
# path comes from the app's own config code, never guessed here.
undo_install() {
  install_ref "$PREV" || fail "não consegui reinstalar $PREV; veja docs/SELF_HOSTING.md (rollback manual)"
  fail "$1; o app continua na $PREV (não foi reiniciado)"
}
DB_FILE="$(as_service "npm run --silent db-path")" || undo_install "não consegui descobrir onde fica o banco"
DB_FILE="$(printf '%s\n' "$DB_FILE" | tail -n 1)"
case "$DB_FILE" in /*/portfolio.db) ;; *) undo_install "caminho do banco inesperado: $DB_FILE" ;; esac
as_service "test -f \"$DB_FILE\"" || undo_install "banco não encontrado em $DB_FILE"
RESTORE_LINE="$(as_service "npm run --silent backup")" || undo_install "backup antes de reiniciar falhou"
RESTORE_FILE="$(backup_file "$RESTORE_LINE")"
[ -n "$RESTORE_FILE" ] || undo_install "não entendi a saída do backup: $RESTORE_LINE"
log "$RESTORE_LINE"

log "reiniciando o serviço"
sh -c "$RESTART_CMD" || log "aviso: o comando de reinício falhou"

if wait_for_version "$TAG"; then
  log "OK: $TAG no ar ($HEALTH_URL)"
  exit 0
fi

log "a $TAG não respondeu em ${HEALTH_TIMEOUT}s; voltando para $PREV"
# Stopped first, so launchd does not restart the old code on the new database meanwhile.
stop_service
install_ref "$PREV" || fail "não consegui reinstalar $PREV; o serviço está parado. Veja docs/SELF_HOSTING.md (rollback manual). Backup: $RESTORE_FILE"
if ! restore_database; then
  # Old code on a database the new version may have migrated would half-work.
  # Start it only when the database is provably unchanged since the backup.
  if as_service "cmp -s \"$RESTORE_FILE\" \"$DB_FILE\" && [ ! -s \"$DB_FILE-wal\" ]"; then
    log "o banco não mudou desde o backup; ligando a $PREV com ele"
  else
    fail "o banco NÃO foi restaurado e a $TAG pode tê-lo alterado; o serviço ficou PARADO de propósito. Libere espaço e siga o rollback manual em docs/SELF_HOSTING.md com o backup $RESTORE_FILE"
  fi
fi
start_service || fail "código da $PREV reinstalado, mas o serviço não ligou. Rode: sudo $START_CMD. Backup: $RESTORE_FILE"
if wait_for_version "$PREV_RUNNING"; then
  fail "atualização desfeita; $PREV de volta no ar. Backups: $BACKUP_LINE / $RESTORE_LINE"
fi
fail "o app não voltou a responder; siga o rollback manual em docs/SELF_HOSTING.md. Backups: $BACKUP_LINE / $RESTORE_LINE"
