#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_ENV_FILE="$ROOT_DIR/.pi.env"

if [[ -f "$PI_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$PI_ENV_FILE"
fi

PI_USER="${PI_USER:-pi}"
PI_PORT="${PI_PORT:-22}"
PI_REMOTE_DIR="${PI_REMOTE_DIR:-~/loki-doki}"
PI_SSH_KEY="${PI_SSH_KEY:-}"
PI_SSH_EXTRA_OPTS="${PI_SSH_EXTRA_OPTS:-}"
PI_REMOTE_HOME="/home/$PI_USER"

if [[ "$PI_REMOTE_DIR" == "$HOME/"* ]]; then
  PI_REMOTE_DIR="~/${PI_REMOTE_DIR#"$HOME"/}"
fi
if [[ "$PI_REMOTE_DIR" == "~/"* ]]; then
  PI_REMOTE_DIR="$PI_REMOTE_HOME/${PI_REMOTE_DIR:2}"
fi
if [[ "$PI_REMOTE_DIR" == "~" ]]; then
  PI_REMOTE_DIR="$PI_REMOTE_HOME"
fi

require_pi_host() {
  if [[ -z "${PI_HOST:-}" ]]; then
    echo "PI_HOST is not set. Fill in .pi.env first." >&2
    exit 1
  fi
}

ssh_target() {
  require_pi_host
  printf "%s@%s" "$PI_USER" "$PI_HOST"
}

ssh_args() {
  local args=("-p" "$PI_PORT")
  if [[ -n "$PI_SSH_KEY" ]]; then
    args+=("-i" "$PI_SSH_KEY")
  fi
  if [[ -n "$PI_SSH_EXTRA_OPTS" ]]; then
    # shellcheck disable=SC2206
    local extra=( $PI_SSH_EXTRA_OPTS )
    args+=("${extra[@]}")
  fi
  printf "%s\n" "${args[@]}"
}

collect_ssh_args() {
  local line
  local -a args=()
  while IFS= read -r line; do
    args+=("$line")
  done < <(ssh_args)
  printf "%s\0" "${args[@]}"
}

run_ssh() {
  local -a args
  while IFS= read -r -d '' arg; do
    args+=("$arg")
  done < <(collect_ssh_args)
  ssh "${args[@]}" "$(ssh_target)" "$@"
}

run_rsync() {
  local -a args
  while IFS= read -r -d '' arg; do
    args+=("$arg")
  done < <(collect_ssh_args)
  rsync -az --delete -e "ssh ${args[*]}" "$@"
}

remote_pid_file() {
  printf "%s/.lokidoki/pi-run.pid" "$PI_REMOTE_DIR"
}

remote_log_file() {
  printf "%s/.lokidoki/pi-run.log" "$PI_REMOTE_DIR"
}
