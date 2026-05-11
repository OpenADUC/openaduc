#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
#
# OpenADUC installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/OpenADUC/openaduc/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/OpenADUC/openaduc/main/install.sh | bash -s -- --version v0.1.0
#   curl -fsSL https://raw.githubusercontent.com/OpenADUC/openaduc/main/install.sh | bash -s -- --yes
#
# Or, from a checkout:
#   ./install.sh
#   ./install.sh --yes              # autopilot: accept all defaults, embedded DB
#
# Idempotent: re-running on an existing install prompts for upgrade /
# reconfigure / abort. Never overwrites an existing .env without
# explicit confirmation.
#
# Autopilot mode (--yes / -y / --autopilot):
#   Skips all prompts and uses defaults — install dir $OPENADUC_INSTALL_DIR
#   (default /opt/openaduc), embedded Postgres, public origin derived from
#   hostname, no admin email hint. On an existing install, defaults to
#   "upgrade". Suitable for unattended provisioning.

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO_OWNER="${OPENADUC_REPO_OWNER:-OpenADUC}"
REPO_NAME="${OPENADUC_REPO_NAME:-openaduc}"
DEFAULT_VERSION="${OPENADUC_VERSION:-latest}"
DEFAULT_INSTALL_DIR="${OPENADUC_INSTALL_DIR:-/opt/openaduc}"
AUTOPILOT="${OPENADUC_AUTOPILOT:-0}"

# When piped from curl, stdin is the script itself; read prompts must come
# from the controlling terminal explicitly.
if [ -e /dev/tty ]; then
  TTY=/dev/tty
else
  TTY=/dev/stdin
fi

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------

if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  C_RESET=$(tput sgr0)
  C_BOLD=$(tput bold)
  C_RED=$(tput setaf 1)
  C_GREEN=$(tput setaf 2)
  C_YELLOW=$(tput setaf 3)
  C_BLUE=$(tput setaf 4)
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

step()    { printf "%s==>%s %s\n"        "$C_BLUE$C_BOLD"  "$C_RESET" "$*"; }
ok()      { printf "%s ✓ %s%s\n"          "$C_GREEN"        "$*"       "$C_RESET"; }
warn()    { printf "%s ! %s%s\n"          "$C_YELLOW"       "$*"       "$C_RESET"; }
fail()    { printf "%s ✗ %s%s\n"          "$C_RED$C_BOLD"   "$*"       "$C_RESET" >&2; }
prompt()  { printf "%s?%s %s "            "$C_BOLD"         "$C_RESET" "$*"; }

die() { fail "$*"; exit 1; }

# Run a command; on failure, print the command and exit code, then exit.
run() {
  local rc=0
  "$@" || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "command failed (exit $rc): $*"
    exit 1
  fi
}

ask() {
  local var="$1" question="$2" default="${3:-}" answer
  if [ "$AUTOPILOT" = "1" ]; then
    printf -v "$var" '%s' "$default"
    printf "    %s = %s (autopilot)\n" "$question" "${default:-<empty>}"
    return
  fi
  if [ -n "$default" ]; then
    prompt "$question [$default]:"
  else
    prompt "$question:"
  fi
  IFS= read -r answer < "$TTY" || true
  printf -v "$var" '%s' "${answer:-$default}"
}

ask_secret() {
  local var="$1" question="$2" answer
  if [ "$AUTOPILOT" = "1" ]; then
    die "autopilot cannot supply a secret for: $question"
  fi
  prompt "$question:"
  stty -echo < "$TTY" 2>/dev/null || true
  IFS= read -r answer < "$TTY" || true
  stty echo < "$TTY" 2>/dev/null || true
  printf '\n'
  printf -v "$var" '%s' "$answer"
}

ask_choice() {
  local var="$1" question="$2"; shift 2
  local choices=("$@") i=1 answer=""
  if [ "$AUTOPILOT" = "1" ]; then
    printf -v "$var" '%s' "${choices[0]}"
    printf "    %s = %s (autopilot)\n" "$question" "${choices[0]}"
    return
  fi
  printf "%s?%s %s\n" "$C_BOLD" "$C_RESET" "$question"
  for c in "${choices[@]}"; do
    printf "    %d) %s\n" "$i" "$c"
    i=$((i + 1))
  done
  while :; do
    prompt "Pick a number [1]:"
    IFS= read -r answer < "$TTY" || true
    answer="${answer:-1}"
    if [[ "$answer" =~ ^[0-9]+$ ]] && [ "$answer" -ge 1 ] && [ "$answer" -le "${#choices[@]}" ]; then
      printf -v "$var" '%s' "${choices[$((answer - 1))]}"
      return
    fi
    warn "please enter a number between 1 and ${#choices[@]}"
  done
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

check_prereqs() {
  step "Checking prerequisites"

  command -v docker >/dev/null 2>&1 || die "docker is not installed. See https://docs.docker.com/engine/install/"
  ok "docker found ($(docker --version))"

  if ! docker compose version >/dev/null 2>&1; then
    die "Docker Compose v2 plugin not found. See https://docs.docker.com/compose/install/"
  fi
  ok "docker compose v2 found ($(docker compose version --short))"

  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets"
  ok "openssl found"

  command -v curl >/dev/null 2>&1 || die "curl is required to download the release tarball"

  if ! docker info >/dev/null 2>&1; then
    die "cannot talk to the docker daemon. Are you in the docker group, or do you need sudo?"
  fi
  ok "docker daemon reachable"
}

# ---------------------------------------------------------------------------
# Install directory + idempotent re-run handling
# ---------------------------------------------------------------------------

choose_install_dir() {
  step "Choosing install directory"
  ask INSTALL_DIR "Install directory" "$DEFAULT_INSTALL_DIR"

  if [ -e "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    warn "An existing OpenADUC install was found at $INSTALL_DIR."
    ask_choice MODE "What should I do?" "upgrade" "reconfigure" "abort"
    case "$MODE" in
      abort) die "aborted by user." ;;
      upgrade)     ;;
      reconfigure) ;;
    esac
  else
    MODE="install"
    if [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
      die "$INSTALL_DIR exists and is not empty, but does not look like an OpenADUC install. Refusing to overwrite."
    fi
    mkdir -p "$INSTALL_DIR"
  fi
  ok "install directory: $INSTALL_DIR (mode: $MODE)"
}

# ---------------------------------------------------------------------------
# Prompts (skipped on upgrade)
# ---------------------------------------------------------------------------

gather_settings() {
  if [ "$MODE" = "upgrade" ]; then
    step "Upgrade — skipping configuration prompts"
    # shellcheck disable=SC1090,SC1091
    [ -f "$INSTALL_DIR/.env" ] && . "$INSTALL_DIR/.env" 2>/dev/null || true
    # Recover DB_MODE for downstream steps. New installs persist the marker;
    # older installs are sniffed by whether the embedded Postgres credentials
    # are populated.
    if [ -n "${OPENADUC_DB_MODE:-}" ]; then
      DB_MODE="$OPENADUC_DB_MODE"
    elif [ -n "${POSTGRES_USER:-}" ]; then
      DB_MODE="embedded"
    else
      DB_MODE="external"
    fi
    PUBLIC_ORIGIN="${API_CORS_ORIGIN:-${PUBLIC_ORIGIN:-}}"
    ok "detected db_mode=$DB_MODE from existing .env"
    return
  fi

  step "Configuration"
  ask_choice DB_MODE "Database" "embedded — use the bundled Postgres container" "external — connect to an existing Postgres"
  if [[ "$DB_MODE" == external* ]]; then
    DB_MODE="external"
    ask EXT_DB_HOST     "External Postgres host"
    ask EXT_DB_PORT     "External Postgres port"     "5432"
    ask EXT_DB_NAME     "External Postgres database" "openaduc"
    ask EXT_DB_USER     "External Postgres username" "openaduc"
    ask_secret EXT_DB_PASS "External Postgres password"
  else
    DB_MODE="embedded"
  fi

  ask PUBLIC_ORIGIN "Public origin URL the web UI will be served at" "https://$(hostname -f 2>/dev/null || hostname)"
  ask ADMIN_EMAIL   "Admin email (optional, used to pre-fill the setup wizard)" ""
}

# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

fetch_source() {
  step "Fetching OpenADUC ($DEFAULT_VERSION)"
  local url tmpdir
  if [ "$DEFAULT_VERSION" = "latest" ]; then
    url="https://github.com/$REPO_OWNER/$REPO_NAME/archive/refs/heads/main.tar.gz"
  else
    url="https://github.com/$REPO_OWNER/$REPO_NAME/archive/refs/tags/$DEFAULT_VERSION.tar.gz"
  fi
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' RETURN
  if ! curl -fsSL "$url" | tar -xz -C "$tmpdir"; then
    die "could not download $url"
  fi
  # tarball extracts to a single top-level dir; copy contents into INSTALL_DIR.
  local extracted
  extracted=$(find "$tmpdir" -mindepth 1 -maxdepth 1 -type d | head -1)
  [ -n "$extracted" ] || die "could not locate extracted source in $tmpdir"

  # Preserve .env across upgrades.
  if [ -f "$INSTALL_DIR/.env" ]; then
    cp "$INSTALL_DIR/.env" "$tmpdir/.env.preserved"
  fi
  # Replace contents (but keep the directory itself, in case it's a mount point).
  find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +
  cp -a "$extracted"/. "$INSTALL_DIR"/
  ok "extracted to $INSTALL_DIR"
}

# ---------------------------------------------------------------------------
# Compose template + .env
# ---------------------------------------------------------------------------

write_compose() {
  step "Writing docker-compose.yml ($DB_MODE)"
  local src
  if [ "$DB_MODE" = "embedded" ]; then
    src="$INSTALL_DIR/docker-compose.embedded.yml"
  else
    src="$INSTALL_DIR/docker-compose.external-db.yml"
  fi
  [ -f "$src" ] || die "missing template: $src"
  cp "$src" "$INSTALL_DIR/docker-compose.yml"
  ok "compose template installed"
}

write_env() {
  step "Writing .env"
  local env_file="$INSTALL_DIR/.env"

  if [ -f "$env_file" ] && [ "$MODE" != "reconfigure" ]; then
    ok ".env preserved (existing file kept)"
    return
  fi

  if [ -f "$env_file" ]; then
    local backup="$env_file.bak.$(date +%s)"
    cp "$env_file" "$backup"
    warn "existing .env backed up to $backup"
  fi

  local cookie_secret enc_key db_url pg_user pg_pass pg_db
  cookie_secret=$(openssl rand -hex 32)
  enc_key=$(openssl rand -base64 32)

  if [ "$DB_MODE" = "external" ]; then
    db_url="postgres://$EXT_DB_USER:$EXT_DB_PASS@$EXT_DB_HOST:$EXT_DB_PORT/$EXT_DB_NAME"
    pg_user=""
    pg_pass=""
    pg_db=""
  else
    pg_user="openaduc"
    pg_pass=$(openssl rand -hex 24)
    pg_db="openaduc"
    db_url="postgres://$pg_user:$pg_pass@postgres:5432/$pg_db"
  fi

  cat > "$env_file" <<EOF
# Generated by install.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Edit with care. Rotating SESSION_COOKIE_SECRET signs everyone out;
# losing ENCRYPTION_KEY makes encrypted DB rows unrecoverable.

# Marker read by install.sh on upgrade — do not edit by hand.
OPENADUC_DB_MODE=$DB_MODE

NODE_ENV=production
LOG_LEVEL=info

API_HOST=0.0.0.0
API_PORT=3000
API_CORS_ORIGIN=$PUBLIC_ORIGIN

SESSION_COOKIE_SECRET=$cookie_secret
SESSION_IDLE_TIMEOUT_MINUTES=60
SESSION_ABSOLUTE_TIMEOUT_HOURS=12
STEP_UP_TTL_MINUTES=60

ENCRYPTION_KEY=$enc_key

DATABASE_URL=$db_url
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=10

# Embedded Postgres credentials — consumed by the postgres service in
# docker-compose.yml. Must match the user/password/database in DATABASE_URL.
# Leave blank when using an external database.
POSTGRES_USER=$pg_user
POSTGRES_PASSWORD=$pg_pass
POSTGRES_DB=$pg_db

# Active Directory connection — leave commented and use the setup wizard.
# AD_LDAP_URLS=
# AD_DOMAIN=
# AD_BASE_DN=
# AD_SERVICE_ACCOUNT_UPN=
# AD_SERVICE_ACCOUNT_PASSWORD=
AD_TLS_REJECT_UNAUTHORIZED=1
AD_OPERATION_TIMEOUT_MS=15000

# Optional: AD group whose members get auto-admin until in-app roles are configured.
# BOOTSTRAP_ADMIN_GROUP_DN=

VITE_API_BASE_URL=/api
EOF
  chmod 600 "$env_file"
  ok ".env written (mode 600)"
  if [ -n "${ADMIN_EMAIL:-}" ]; then
    printf "OPENADUC_ADMIN_EMAIL_HINT=%s\n" "$ADMIN_EMAIL" >> "$env_file"
  fi
}

# ---------------------------------------------------------------------------
# Bring the stack up
# ---------------------------------------------------------------------------

bring_up() {
  step "Pulling / building images"
  ( cd "$INSTALL_DIR" && docker compose pull --ignore-pull-failures 2>/dev/null || true )
  ( cd "$INSTALL_DIR" && run docker compose build )

  step "Starting the stack"
  ( cd "$INSTALL_DIR" && run docker compose up -d )

  if [ "$DB_MODE" = "embedded" ]; then
    step "Waiting for Postgres to be healthy"
    local i
    for i in $(seq 1 30); do
      if ( cd "$INSTALL_DIR" && docker compose ps postgres --format json 2>/dev/null | grep -q '"Health":"healthy"' ); then
        ok "postgres healthy"
        break
      fi
      sleep 2
      if [ "$i" -eq 30 ]; then
        warn "postgres did not report healthy within 60s — continuing anyway"
      fi
    done
  fi

  step "Running database migrations"
  # Invoke tsx + knex directly instead of `pnpm migrate:latest` — pnpm's
  # verify-deps-before-run would try to write to /app/apps/api, which the
  # non-root runtime user can't do, and would also pull a fresh pnpm via
  # corepack. tsx and knex are already in node_modules; just use them.
  ( cd "$INSTALL_DIR" && run docker compose exec -T api node node_modules/tsx/dist/cli.mjs node_modules/knex/bin/cli.js --knexfile knexfile.ts migrate:latest )
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

print_done() {
  printf "\n%s%sOpenADUC is up.%s\n" "$C_GREEN" "$C_BOLD" "$C_RESET"
  printf "  Web UI:    %s\n" "$PUBLIC_ORIGIN"
  printf "  Install:   %s\n" "$INSTALL_DIR"
  printf "  Logs:      cd %s && docker compose logs -f\n" "$INSTALL_DIR"
  printf "  Stop:      cd %s && docker compose down\n"   "$INSTALL_DIR"
  printf "\n"
  printf "Open %s in a browser to complete the first-run setup wizard.\n" "$PUBLIC_ORIGIN"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --version)         DEFAULT_VERSION="$2"; shift 2 ;;
    --install-dir)     DEFAULT_INSTALL_DIR="$2"; shift 2 ;;
    -y|--yes|--autopilot) AUTOPILOT=1; shift ;;
    -h|--help)
      sed -n '2,23p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

printf "%s%sOpenADUC installer%s\n\n" "$C_BOLD" "$C_BLUE" "$C_RESET"

check_prereqs
choose_install_dir
gather_settings
fetch_source
write_compose
write_env
bring_up
print_done
