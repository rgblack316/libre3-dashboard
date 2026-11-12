#!/usr/bin/env bash
# Libre3 Dashboard installer (Ubuntu/Debian). Installs Docker if needed, downloads the app from
# GitHub, creates .env from your LibreLinkUp follower credentials, tests the login, then starts it.
#
#   curl -fsSL https://raw.githubusercontent.com/rgblack316/libre3-dashboard/main/install.sh | bash
#
# Re-run the same command to update. Your .env and data/ are never touched.
#
# Optional environment variables:
#   INSTALL_DIR   where to install            (default: ~/libre3-dashboard)
#   BRANCH        branch to install           (default: main)
#   REPO          GitHub owner/name           (default: rgblack316/libre3-dashboard)
#   GITHUB_TOKEN  token for a private repo
#   LLU_EMAIL / LLU_PASSWORD  skip the prompts (visible in shell history, so prompting is safer)

set -euo pipefail

REPO="${REPO:-rgblack316/libre3-dashboard}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/libre3-dashboard}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
TARBALL_URL="${TARBALL_URL:-}" # override the download URL (testing, forks)

say()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Wrap a value for a Docker Compose env file: double quotes, with \ " and $ escaped.
dq() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//\$/\\\$}
  printf '"%s"' "$s"
}

has_tty() { ( : </dev/tty ) 2>/dev/null; }

preflight() {
  [ "$(id -u)" -ne 0 ] || die "Run this as a normal user with sudo access, not as root."
  have sudo || die "sudo is required."
  have apt-get || warn "apt-get not found; this script is written for Ubuntu/Debian."
  sudo -v || die "Could not get sudo access."
  if ! have curl; then
    say "Installing curl"
    sudo apt-get update -qq
    sudo apt-get install -y -qq curl ca-certificates
  fi
  have tar || die "tar is required."
}

ensure_docker() {
  if ! have docker; then
    say "Installing Docker (official get.docker.com script)"
    curl -fsSL https://get.docker.com | sudo sh
  fi
  sudo systemctl enable --now docker >/dev/null 2>&1 || true

  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  else
    DOCKER=(sudo docker) # user is not in the docker group; use sudo instead
  fi
  "${DOCKER[@]}" compose version >/dev/null 2>&1 \
    || die "The Docker Compose plugin is missing. Install 'docker-compose-plugin' and re-run."
  DC=("${DOCKER[@]}" compose)
}

fetch_source() {
  local url="$TARBALL_URL"
  local -a auth=()
  if [ -z "$url" ]; then
    if [ -n "$GITHUB_TOKEN" ]; then
      url="https://api.github.com/repos/$REPO/tarball/$BRANCH"
      auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
    else
      url="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
    fi
  fi

  say "Downloading $REPO ($BRANCH) to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  if ! curl -fsSL ${auth[@]+"${auth[@]}"} "$url" | tar -xz --strip-components=1 -C "$INSTALL_DIR"; then
    die "Download failed. If the repo is private, re-run with GITHUB_TOKEN set to a token that can read it."
  fi
  [ -f "$INSTALL_DIR/Dockerfile" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ] \
    || die "Downloaded files don't look like the dashboard (no Dockerfile / docker-compose.yml)."
}

write_env() {
  local email=$1 pass=$2
  (
    umask 077
    {
      printf 'LLU_EMAIL=%s\n' "$(dq "$email")"
      printf 'LLU_PASSWORD=%s\n' "$(dq "$pass")"
      printf 'LLU_REGION=\nLLU_PATIENT_ID=\n'
    } >"$ENV_FILE"
  )
}

# Set KEY=VALUE in .env unless it already has a non-empty value.
set_if_blank() {
  local key=$1 val=$2
  if grep -q "^$key=." "$ENV_FILE"; then
    return 0
  elif grep -q "^$key=" "$ENV_FILE"; then
    sed -i "s|^$key=.*|$key=$val|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >>"$ENV_FILE"
  fi
}

gen_password() {
  local p
  p=$( (head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16) 2>/dev/null || true)
  [ "${#p}" -eq 16 ] || die "Could not generate an admin password."
  printf '%s' "$p"
}

detect_tz() {
  if have timedatectl; then
    timedatectl show -p Timezone --value 2>/dev/null || true
  elif [ -f /etc/timezone ]; then
    cat /etc/timezone
  fi
}

setup_env() {
  ENV_FILE="$INSTALL_DIR/.env"
  FRESH=0
  NEEDS_CREDS=0

  if [ -f "$ENV_FILE" ]; then
    say "Keeping your existing .env"
  else
    FRESH=1
    local email="${LLU_EMAIL:-}" pass="${LLU_PASSWORD:-}"
    if [ -z "$email" ] || [ -z "$pass" ]; then
      if has_tty; then
        say "LibreLinkUp follower account (use a dedicated follower account, not your main Libre login)"
        printf 'Email: ' >&2
        IFS= read -r email </dev/tty
        printf 'Password (hidden): ' >&2
        IFS= read -rs pass </dev/tty
        printf '\n' >&2
      fi
    fi
    if [ -n "$email" ] && [ -n "$pass" ]; then
      case "$email$pass" in *$'\n'*) die "Email and password cannot contain line breaks." ;; esac
      write_env "$email" "$pass"
    else
      NEEDS_CREDS=1
      ( umask 077; cp "$INSTALL_DIR/.env.example" "$ENV_FILE" )
    fi
  fi

  # The container runs as your user so it can write to ./data.
  grep -q '^PUID=' "$ENV_FILE" || printf 'PUID=%s\n' "$(id -u)" >>"$ENV_FILE"
  grep -q '^PGID=' "$ENV_FILE" || printf 'PGID=%s\n' "$(id -g)" >>"$ENV_FILE"
  # Admin page password: generated once and shown at the end (change it later in /admin).
  ADMIN_PW_NEW=""
  if ! grep -q '^ADMIN_PASSWORD=.' "$ENV_FILE"; then
    ADMIN_PW_NEW=$(gen_password)
    set_if_blank ADMIN_PASSWORD "$ADMIN_PW_NEW"
  fi
  set_if_blank HOST_PORT 8080
  local tz; tz=$(detect_tz | tr -cd 'A-Za-z0-9_/+-')
  [ -n "$tz" ] && set_if_blank TZ "$tz"
  chmod 600 "$ENV_FILE"
  mkdir -p "$INSTALL_DIR/data"
}

main() {
  preflight
  ensure_docker
  fetch_source
  setup_env
  cd "$INSTALL_DIR"

  say "Building the image"
  "${DC[@]}" build

  if [ "$NEEDS_CREDS" -eq 1 ]; then
    say "No LibreLinkUp credentials entered; you can add them on the Account tab of the admin page"
  else
    say "Testing the Libre login (nothing is started yet)"
    if ! "${DC[@]}" run --rm libre node --disable-warning=ExperimentalWarning scripts/test-login.js; then
      if [ "$FRESH" -eq 1 ]; then
        die "Login test failed, so the service was not started. Check LLU_EMAIL / LLU_PASSWORD in $INSTALL_DIR/.env (and that the follower account has accepted the invite in the LibreLinkUp app), then re-run this installer."
      fi
      warn "Login test failed; starting anyway because this is an update. Check '${DC[*]} logs libre'."
    fi
  fi

  say "Starting the dashboard"
  "${DC[@]}" up -d
  sleep 5
  "${DC[@]}" logs --tail 5 libre || true

  local HOST_IP PORT_OUT ADMIN_LINE
  HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}'); HOST_IP=${HOST_IP:-localhost}
  PORT_OUT=$(grep '^HOST_PORT=' "$ENV_FILE" | cut -d= -f2); PORT_OUT=${PORT_OUT:-8080}
  if [ -n "$ADMIN_PW_NEW" ]; then
    ADMIN_LINE="Admin password (shown once; also in $ENV_FILE): $ADMIN_PW_NEW"
  else
    ADMIN_LINE="Admin password: unchanged (see ADMIN_PASSWORD in $ENV_FILE if never changed in the app)"
  fi

  cat <<EOF

Installed in $INSTALL_DIR

Display:  http://$HOST_IP:$PORT_OUT/display
Admin:    http://$HOST_IP:$PORT_OUT/admin
$ADMIN_LINE

Useful commands (run in that folder):
  ${DC[*]} logs -f libre     watch polls
  ${DC[*]} ps                health status
  ${DC[*]} restart libre     restart after editing .env
  ${DC[*]} down              stop

Update: re-run the install command. Your .env and data/ are kept.
EOF
  if [ "${DOCKER[0]}" = "sudo" ]; then
    echo "Note: your user isn't in the docker group, so those commands need sudo (included above)."
  fi
}

main "$@"
