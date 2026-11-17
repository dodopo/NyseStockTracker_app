#!/bin/sh
# -----------------------------------------------------------------------------
# Dodopo Asset Manager: one-time migration of a self-hosted install from the
# old names (user nysetracker, local.nysetracker.*, nysetracker-update; up to
# v0.11.x) to the new ones (user dodopoam, local.dodopoam.*, dodopoam-update).
#
#   sudo sh dodopoam-migrate --dry-run v0.12.0   # read-only checks, prints the plan
#   sudo sh dodopoam-migrate v0.12.0             # migrate
#   sudo sh dodopoam-migrate --rollback          # go back to the old install
#
# Nothing of the old install is deleted: its user, app and data stay as they
# are; its services and update command are only parked in PARK_DIR so they do
# not come back on a reboot. Every step after the old app is stopped is undone
# automatically if anything fails, including an unexpected exit or Ctrl+C.
# A dropped SSH session does not stop the script (HUP is ignored during the
# switch) and everything is also written to PARK_DIR/migrate.log.
#
# Steps
#   1. preflight (read-only): root, old install running, free UID, tag published
#   2. create the new user, clone the tag, npm ci + build + tests (old app still up)
#   3. copy .env (paths rewritten) and back up the old database
#   4. stop the old app, copy data byte for byte (verified with cmp + integrity check)
#   5. park the old services/command, install and start the new ones on the same port
#   6. wait for /api/health to report the new version, install dodopoam-update
#
# Settings (environment variables, optional; mostly for tests):
#   DAM_NEW_UID          UID of the new user        (default: 510)
#   DAM_REPO_URL         repository to clone        (default: GitHub dodopo/dodopo-asset-manager)
#   DAM_HEALTH_TIMEOUT   seconds to wait for health (default: 60)
#   DAM_POLL             seconds between checks     (default: 2)
#   DAM_MIGRATE_ROOT     filesystem prefix          (default: empty; tests only)
# -----------------------------------------------------------------------------
set -eu

OLD_USER=nysetracker
NEW_USER=dodopoam
NEW_UID="${DAM_NEW_UID:-510}"
REPO_URL="${DAM_REPO_URL:-https://github.com/dodopo/dodopo-asset-manager.git}"
HEALTH_TIMEOUT="${DAM_HEALTH_TIMEOUT:-60}"
POLL="${DAM_POLL:-2}"
R="${DAM_MIGRATE_ROOT:-}"
case "$POLL" in ""|*[!0-9]*|0) POLL=1 ;; esac

OLD_HOME="$R/Users/$OLD_USER"
NEW_HOME="$R/Users/$NEW_USER"
LD_DIR="$R/Library/LaunchDaemons"
SBIN="$R/usr/local/sbin"
PARK_DIR="$R/usr/local/share/dodopoam-migration"
OLD_LABEL=local.nysetracker
NEW_LABEL=local.dodopoam
OLD_CMD=nysetracker-update
NEW_CMD=dodopoam-update
SELF="sh /usr/local/sbin/dodopoam-migrate"

LOGFILE=""
SWITCHING=0
COMMITTED=0
ROLLED_BACK=0
BACKUP_LINE=""

# Output is best effort (the terminal may be gone); the log file keeps everything.
log() {
  printf '[migrar] %s\n' "$*" 2>/dev/null || true
  if [ -n "$LOGFILE" ]; then printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >> "$LOGFILE" 2>/dev/null || true; fi
}
fail() {
  printf '[migrar] ERRO: %s\n' "$*" >&2 2>/dev/null || true
  if [ -n "$LOGFILE" ]; then printf '%s ERRO: %s\n' "$(date +%H:%M:%S)" "$*" >> "$LOGFILE" 2>/dev/null || true; fi
  exit 1
}

# Runs a command as a service user inside its app folder.
as_user() { # $1 = user, $2 = command
  sudo -u "$1" -H sh -c "cd \"$R/Users/$1/app\" && $2"
}

env_value() { # $1 = .env file, $2 = key -> last value, empty if missing
  sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n 1
}

running_version() { # version reported by /api/health; empty if down
  curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

port_busy() { # true while something listens on the port (lsof missing: assume free)
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

wait_until() { # $1 = "up:<version>" | "up" | "down"
  want="$1"
  elapsed=0
  while [ "$elapsed" -le "$HEALTH_TIMEOUT" ]; do
    v="$(running_version || true)"
    case "$want" in
      down) [ -z "$v" ] && ! port_busy && return 0 ;;
      up) [ -n "$v" ] && return 0 ;;
      up:*) [ "$v" = "${want#up:}" ] && return 0 ;;
    esac
    sleep "$POLL"
    elapsed=$((elapsed + POLL))
  done
  return 1
}

user_exists() { dscl . -read "/Users/$1" UniqueID >/dev/null 2>&1; }
user_uid() { dscl . -read "/Users/$1" UniqueID 2>/dev/null | awk '{print $2}'; }
uid_owner() { dscl . -list /Users UniqueID 2>/dev/null | awk -v u="$1" '$2 == u {print $1}'; }
label_loaded() { launchctl print "system/$1" >/dev/null 2>&1; }

# Writes a root-owned LaunchDaemon from the template of the release tag (read
# from git, not from the working tree) and checks it runs as the new user only.
render_plist() { # $1 = app|backup
  dst="$LD_DIR/$NEW_LABEL.$1.plist"
  tmp="$(mktemp "${TMPDIR:-/tmp}/dam-plist.XXXXXX")" || return 1
  as_user "$NEW_USER" "git show \"$TAG:deploy/macos/$NEW_LABEL.$1.plist\"" > "$tmp" || { rm -f "$tmp"; return 1; }
  sed -i.bak -e "s|__SERVICE_USER__|$NEW_USER|g" -e "s|__HOME__|/Users/$NEW_USER|g" "$tmp" && rm -f "$tmp.bak"
  if [ "$(grep -c '<key>UserName</key>' "$tmp")" != 1 ] \
    || ! grep -q "<key>UserName</key><string>$NEW_USER</string>" "$tmp" \
    || ! grep -q "<key>Label</key><string>$NEW_LABEL.$1</string>" "$tmp" \
    || grep -q '<key>GroupName</key>\|<key>InitGroups</key>\|__' "$tmp"; then
    rm -f "$tmp"
    log "o modelo $NEW_LABEL.$1.plist da $TAG não passou na conferência (usuário/rótulo)"
    return 1
  fi
  chown root:wheel "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$dst"
}

# --- rollback ----------------------------------------------------------------
# Puts the old install back in service. Safe to run more than once.
rollback() {
  set +e
  ROLLED_BACK=1
  log "desfazendo: voltando para a instalação antiga"
  for f in app backup; do
    launchctl bootout "system/$NEW_LABEL.$f" >/dev/null 2>&1
    rm -f "$LD_DIR/$NEW_LABEL.$f.plist"
  done
  new_stuck=0
  if label_loaded "$NEW_LABEL.app"; then new_stuck=1; log "não consegui parar $NEW_LABEL.app"; fi
  rm -f "$SBIN/$NEW_CMD"
  for f in app backup; do
    [ -f "$PARK_DIR/$OLD_LABEL.$f.plist" ] && mv "$PARK_DIR/$OLD_LABEL.$f.plist" "$LD_DIR/$OLD_LABEL.$f.plist"
  done
  [ -f "$PARK_DIR/$OLD_CMD" ] && mv "$PARK_DIR/$OLD_CMD" "$SBIN/$OLD_CMD"
  for f in app backup; do
    if ! label_loaded "$OLD_LABEL.$f" && [ -f "$LD_DIR/$OLD_LABEL.$f.plist" ]; then
      launchctl bootstrap system "$LD_DIR/$OLD_LABEL.$f.plist" || log "aviso: não consegui religar $OLD_LABEL.$f"
    fi
  done
  old_version="$(sed -n 's/^from=//p' "$PARK_DIR/state" 2>/dev/null | tail -n 1)"
  if [ "$new_stuck" = 0 ] && wait_until "up${old_version:+:$old_version}"; then
    if [ -d "$PARK_DIR" ]; then mv "$PARK_DIR" "$PARK_DIR.desfeita-$(date +%Y%m%d-%H%M%S)"; fi
    log "instalação antiga de volta no ar (versão $(running_version))"
    return 0
  fi
  log "a instalação antiga não voltou a responder${old_version:+ na versão $old_version}."
  log "os serviços antigos estão de volta em $LD_DIR (um reboot também os religa)."
  log "tente: sudo launchctl bootout system/$NEW_LABEL.app ; sudo launchctl kickstart -k system/$OLD_LABEL.app"
  log "e veja $OLD_HOME/logs/app.log"
  return 1
}

on_exit() {
  status=$?
  if [ "$SWITCHING" = 1 ] && [ "$COMMITTED" = 0 ] && [ "$ROLLED_BACK" = 0 ]; then
    log "saída inesperada durante a troca"
    rollback
    status=1
  fi
  exit "$status"
}

switch_failed() {
  set +e
  log "ERRO: $*"
  if [ "$ROLLED_BACK" = 0 ]; then rollback; fi
  fail "migração desfeita. Backup tirado antes: $BACKUP_LINE"
}

# --- arguments ---------------------------------------------------------------
MODE=migrate
TAG=""
case "${1:-}" in
  --dry-run) MODE=dry-run; TAG="${2:-}" ;;
  --rollback) MODE=rollback ;;
  *) TAG="${1:-}" ;;
esac

[ "$(id -u)" -eq 0 ] || fail "rode com sudo"
OLD_ENV="$OLD_HOME/app/.env"
[ -f "$OLD_ENV" ] || fail "instalação antiga não encontrada em $OLD_HOME/app"
PORT="$(env_value "$OLD_ENV" PORT)"
PORT="${PORT:-3100}"

if [ "$MODE" = rollback ]; then
  [ -d "$PARK_DIR" ] || fail "não há migração para desfazer ($PARK_DIR não existe)"
  LOGFILE="$PARK_DIR/migrate.log"
  log "aviso: o que foi salvo na versão nova depois da migração fica só em $NEW_HOME/data"
  rollback || exit 1
  log "para tentar a migração de novo, basta rodar o comando outra vez"
  exit 0
fi

printf '%s' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "informe a versão no formato vX.Y.Z (ex.: v0.12.0)"
NEW_VERSION="${TAG#v}"

# --- 1. preflight (read-only) ------------------------------------------------
log "conferindo o ambiente"
[ ! -e "$PARK_DIR" ] \
  || fail "$PARK_DIR já existe: a migração já foi feita ou parou no meio. Para voltar à instalação antiga: sudo $SELF --rollback"
user_exists "$OLD_USER" || fail "usuário $OLD_USER não existe"
[ "$(env_value "$OLD_ENV" DATA_DIR)" = "/Users/$OLD_USER/data" ] \
  || fail "o .env antigo usa DATA_DIR=$(env_value "$OLD_ENV" DATA_DIR); este script só migra DATA_DIR=/Users/$OLD_USER/data"
case "$(env_value "$OLD_ENV" BACKUP_DIR)" in
  ""|"/Users/$OLD_USER/"*) ;;
  *) fail "o .env antigo usa BACKUP_DIR fora de /Users/$OLD_USER; ajuste antes de migrar" ;;
esac
[ -f "$OLD_HOME/data/portfolio.db" ] || fail "banco não encontrado em $OLD_HOME/data/portfolio.db"
for f in app backup; do
  [ -f "$LD_DIR/$OLD_LABEL.$f.plist" ] || fail "serviço antigo não encontrado: $LD_DIR/$OLD_LABEL.$f.plist"
  [ ! -e "$LD_DIR/$NEW_LABEL.$f.plist" ] || fail "serviço novo já instalado ($NEW_LABEL.$f); a migração já foi feita?"
  ! label_loaded "$NEW_LABEL.$f" || fail "serviço novo $NEW_LABEL.$f já está carregado"
done
label_loaded "$OLD_LABEL.app" || fail "o serviço $OLD_LABEL.app não está carregado"

if user_exists "$NEW_USER"; then
  [ "$(user_uid "$NEW_USER")" = "$NEW_UID" ] \
    || fail "usuário $NEW_USER já existe com outro UID ($(user_uid "$NEW_USER")); nada foi feito"
  NEW_USER_STATE="já existe (UID $NEW_UID), será reaproveitado"
else
  owner="$(uid_owner "$NEW_UID")"
  [ -z "$owner" ] || fail "UID $NEW_UID já é do usuário $owner; escolha outro com DAM_NEW_UID"
  NEW_USER_STATE="será criado (UID $NEW_UID)"
fi

PREV_RUNNING="$(running_version || true)"
[ -n "$PREV_RUNNING" ] || fail "o app antigo não está respondendo na porta $PORT; nada foi feito"

git ls-remote --exit-code --tags "$REPO_URL" "refs/tags/$TAG" >/dev/null 2>&1 \
  || fail "a versão $TAG não foi encontrada em $REPO_URL"

log "instalação antiga: $OLD_USER, versão $PREV_RUNNING no ar na porta $PORT"
log "usuário $NEW_USER: $NEW_USER_STATE"
log "versão nova: $TAG de $REPO_URL"
if [ -d "$NEW_HOME/data" ] && [ -n "$(ls -A "$NEW_HOME/data" 2>/dev/null)" ]; then
  log "$NEW_HOME/data tem restos de uma tentativa anterior; serão guardados ao lado (data.tentativa-...), não apagados"
fi

if [ "$MODE" = dry-run ]; then
  cat <<EOF
[migrar] SIMULAÇÃO: nada foi alterado. A migração de verdade vai:
  1. criar/usar o usuário $NEW_USER, clonar $TAG em $NEW_HOME/app, instalar, compilar e testar
  2. copiar o .env (trocando /Users/$OLD_USER por /Users/$NEW_USER) e fazer backup do banco antigo
  3. parar $OLD_LABEL.app e $OLD_LABEL.backup e copiar $OLD_HOME/data para $NEW_HOME/data
  4. guardar os serviços e o $OLD_CMD antigos em $PARK_DIR
  5. ligar $NEW_LABEL.app e $NEW_LABEL.backup na porta $PORT e esperar a versão $NEW_VERSION
  6. instalar $SBIN/$NEW_CMD
  Se algo falhar a partir do passo 3, tudo é desfeito e a instalação antiga volta.
EOF
  exit 0
fi

# --- 2. new user + install (old app still running) ---------------------------
if ! user_exists "$NEW_USER"; then
  log "criando o usuário $NEW_USER (UID $NEW_UID)"
  dscl . -create "/Users/$NEW_USER"
  dscl . -create "/Users/$NEW_USER" UniqueID "$NEW_UID"
  dscl . -create "/Users/$NEW_USER" PrimaryGroupID 20
  dscl . -create "/Users/$NEW_USER" UserShell /usr/bin/false
  dscl . -create "/Users/$NEW_USER" NFSHomeDirectory "/Users/$NEW_USER"
  dscl . -create "/Users/$NEW_USER" RealName "Dodopo Asset Manager service"
  dscl . -create "/Users/$NEW_USER" IsHidden 1
  dscl . -create "/Users/$NEW_USER" Password "*"
fi
mkdir -p "$NEW_HOME/logs"
chown -h "$NEW_USER:staff" "$NEW_HOME" "$NEW_HOME/logs"
chmod 700 "$NEW_HOME"
if [ -d "$NEW_HOME/data" ] && [ -n "$(ls -A "$NEW_HOME/data" 2>/dev/null)" ]; then
  aside="$NEW_HOME/data.tentativa-$(date +%Y%m%d-%H%M%S)"
  log "guardando os restos da tentativa anterior em $aside"
  mv "$NEW_HOME/data" "$aside"
fi
# data/ stays owned by root until the copy is done (the new user runs npm code before that)
mkdir -p "$NEW_HOME/data"
chown -h root:wheel "$NEW_HOME/data"
chmod 700 "$NEW_HOME/data"

if [ ! -d "$NEW_HOME/app/.git" ]; then
  log "clonando $REPO_URL"
  sudo -u "$NEW_USER" -H sh -c "cd \"$NEW_HOME\" && git clone --quiet \"$REPO_URL\" app" \
    || fail "não consegui clonar o repositório; a instalação antiga segue no ar"
fi
log "instalando $TAG, compilando e rodando os testes (o app antigo segue no ar)"
as_user "$NEW_USER" "git fetch --tags --quiet && git diff --quiet && git checkout --quiet \"$TAG\" && npm ci --no-audit --no-fund && npm run build && npm test" \
  || fail "instalação ou testes da $TAG falharam; a instalação antiga segue no ar"
tag_version="$(as_user "$NEW_USER" "git show \"$TAG:package.json\"" | sed -n 's/^  "version": "\([^"]*\)".*/\1/p' | head -n 1)"
[ "$tag_version" = "$NEW_VERSION" ] \
  || fail "a $TAG declara a versão '$tag_version' no package.json; a instalação antiga segue no ar"

log "copiando o .env"
envtmp="$(mktemp "${TMPDIR:-/tmp}/dam-env.XXXXXX")"
sed "s|/Users/$OLD_USER|/Users/$NEW_USER|g" "$OLD_ENV" > "$envtmp"
[ "$(env_value "$envtmp" DATA_DIR)" = "/Users/$NEW_USER/data" ] || { rm -f "$envtmp"; fail "o .env novo não aponta para /Users/$NEW_USER/data"; }
chmod 600 "$envtmp"
chown -h "$NEW_USER:staff" "$envtmp"
mv -f "$envtmp" "$NEW_HOME/app/.env"

log "backup do banco antigo"
BACKUP_LINE="$(as_user "$OLD_USER" "npm run --silent backup")" || fail "backup falhou; a instalação antiga segue no ar"
log "$BACKUP_LINE"

# --- 3. switch (any failure from here on is undone) --------------------------
mkdir -p "$PARK_DIR"
chmod 700 "$PARK_DIR"
LOGFILE="$PARK_DIR/migrate.log"
printf 'tag=%s\nfrom=%s\nbackup=%s\nstarted=%s\n' "$TAG" "$PREV_RUNNING" "$BACKUP_LINE" "$(date +%Y-%m-%dT%H:%M:%S%z)" > "$PARK_DIR/state"
SWITCHING=1
trap on_exit EXIT
trap 'switch_failed "interrompido"' INT TERM
trap '' HUP PIPE
log "registro completo desta etapa: $LOGFILE"

log "parando o app antigo"
for f in app backup; do
  launchctl bootout "system/$OLD_LABEL.$f" >/dev/null 2>&1 || true
done
wait_until down || switch_failed "o app antigo continuou respondendo na porta $PORT"

log "copiando os dados para $NEW_HOME/data"
cp -Rp "$OLD_HOME/data/." "$NEW_HOME/data/" || switch_failed "a cópia dos dados falhou"
for f in portfolio.db portfolio.db-wal; do
  if [ -f "$OLD_HOME/data/$f" ]; then
    cmp -s "$OLD_HOME/data/$f" "$NEW_HOME/data/$f" || switch_failed "a cópia de $f não confere com o original"
  fi
done
chown -R "$NEW_USER:staff" "$NEW_HOME/data" || switch_failed "não consegui ajustar o dono dos dados"
chmod -R go-rwx "$NEW_HOME/data" || switch_failed "não consegui fechar as permissões dos dados"
check="$(sudo -u "$NEW_USER" -H sqlite3 "$NEW_HOME/data/portfolio.db" "PRAGMA integrity_check;" 2>/dev/null)" \
  || switch_failed "não consegui abrir o banco copiado"
[ "$check" = ok ] || switch_failed "o banco copiado não passou na verificação de integridade: $check"

log "guardando os serviços e o comando antigos em $PARK_DIR"
for f in app backup; do
  mv "$LD_DIR/$OLD_LABEL.$f.plist" "$PARK_DIR/" || switch_failed "não consegui guardar $OLD_LABEL.$f.plist"
done
if [ -f "$SBIN/$OLD_CMD" ]; then mv "$SBIN/$OLD_CMD" "$PARK_DIR/" || switch_failed "não consegui guardar $OLD_CMD"; fi

log "ligando os serviços novos"
render_plist app || switch_failed "não consegui instalar $NEW_LABEL.app.plist"
render_plist backup || switch_failed "não consegui instalar $NEW_LABEL.backup.plist"
launchctl bootstrap system "$LD_DIR/$NEW_LABEL.app.plist" || switch_failed "não consegui ligar $NEW_LABEL.app"
wait_until "up:$NEW_VERSION" || switch_failed "a versão $NEW_VERSION não respondeu em ${HEALTH_TIMEOUT}s (veja $NEW_HOME/logs/app.log)"
launchctl bootstrap system "$LD_DIR/$NEW_LABEL.backup.plist" || switch_failed "não consegui ligar $NEW_LABEL.backup"

log "instalando o comando $NEW_CMD"
mkdir -p "$SBIN"
cmdtmp="$(mktemp "$SBIN/.$NEW_CMD.XXXXXX")" || switch_failed "não consegui criar $SBIN/$NEW_CMD"
as_user "$NEW_USER" "git show \"$TAG:scripts/update.sh\"" > "$cmdtmp" \
  && chown root:wheel "$cmdtmp" && chmod 755 "$cmdtmp" && mv -f "$cmdtmp" "$SBIN/$NEW_CMD" \
  || { rm -f "$cmdtmp"; switch_failed "não consegui instalar $SBIN/$NEW_CMD"; }

COMMITTED=1
trap - INT TERM HUP PIPE
printf 'finished=%s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" >> "$PARK_DIR/state" 2>/dev/null || true
log "OK: $TAG no ar como $NEW_USER na porta $PORT"
log "próximas atualizações: sudo $SBIN/$NEW_CMD vX.Y.Z"
log "o usuário $OLD_USER e os dados dele continuam intactos; para voltar: sudo $SELF --rollback"
