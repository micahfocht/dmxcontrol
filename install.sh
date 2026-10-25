#!/usr/bin/env bash
# Install from a checkout on Raspberry Pi OS, Debian, or Ubuntu with systemd.
set -Eeuo pipefail

PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
NODE_DIR=/opt/dmxcontrol
UNIT_DIR=/etc/systemd/system
work_dir=
service=

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
run_root() { if (( EUID == 0 )); then "$@"; else sudo "$@"; fi; }
run_as_user() {
  if (( EUID == 0 )); then
    runuser -u "$install_user" -- env HOME="$install_home" PATH="$NODE_DIR/current/bin:$PATH" "$@"
  else
    env PATH="$NODE_DIR/current/bin:$PATH" "$@"
  fi
}
cleanup() { if [[ -n $work_dir ]]; then rm -rf -- "$work_dir"; fi; }
failed() {
  printf '\nInstallation failed. Fix the error above and rerun ./install.sh.\n' >&2
  if [[ -n $service ]]; then printf 'Service logs: sudo journalctl -u %s -n 50 --no-pager\n' "$service" >&2; fi
}

usage() {
  cat <<'EOF'
Usage: ./install.sh [--with-ola] [--port PORT]

Installs Node.js 22 and production dependencies, then starts DMX Control now
and on every boot. Run as the user who owns this checkout; sudo is used for
system changes. Internet access is required during installation.

  --with-ola   Also install and enable OLA for USB DMX (hardware patching is manual).
  --port PORT  HTTP port, 1024-65535 (default: saved port, otherwise 3000).
  -h, --help   Show this help.
EOF
}

require_platform() {
  [[ $(uname -s) == Linux && -f /etc/debian_version ]] || die 'This installer requires Raspberry Pi OS, Debian, or Ubuntu.'
  [[ -d /run/systemd/system ]] || die 'This installer requires a running systemd system.'
  command -v apt-get >/dev/null || die 'apt-get is required.'
  if (( EUID == 0 )); then
    install_user=${SUDO_USER:-}
    [[ -n $install_user && $install_user != root ]] || die 'Run ./install.sh as the normal user who owns the checkout (with sudo access).'
  else
    install_user=$(id -un)
    command -v sudo >/dev/null || die 'sudo is required to install packages and the system service.'
    sudo -v
  fi
  install_home=$(getent passwd "$install_user" | cut -d: -f6)
  install_group=$(id -gn "$install_user")
  [[ $install_home == /* ]] || die 'Could not find the installation user home directory.'
  case $(dpkg --print-architecture) in
    arm64) node_arch=arm64 ;;
    armhf)
      [[ $(uname -m) != armv6l ]] || die 'Pi 1/Zero ARMv6 hardware is unsupported. Use a Pi 2/3/4 or newer.'
      node_arch=armv7l ;;
    amd64) node_arch=x64 ;;
    *) die 'Supported OS architectures are arm64, armhf (Pi 2/3/4), and amd64. Pi 1/Zero ARMv6 is unsupported.' ;;
  esac
}

install_node() {
  # Resolve once from the official checksum list, then download a versioned URL.
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
    https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$work_dir/SHASUMS256.txt"
  local archive checksum release version
  archive=$(awk -v arch="$node_arch" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") { print $2 }' "$work_dir/SHASUMS256.txt")
  [[ $archive =~ ^node-v22\.[0-9]+\.[0-9]+-linux-${node_arch}\.tar\.xz$ ]] || die 'Could not resolve the Node.js 22 download for this architecture.'
  release=${archive%.tar.xz}
  version=${release#node-}
  version=${version%-linux-*}
  if [[ ! -x $NODE_DIR/$release/bin/node ]]; then
    printf 'Installing %s…\n' "$release"
    curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 600 \
      "https://nodejs.org/dist/$version/$archive" -o "$work_dir/$archive"
    checksum=$(awk -v file="$archive" '$2 == file { print $1 "  " $2 }' "$work_dir/SHASUMS256.txt")
    (cd "$work_dir" && printf '%s\n' "$checksum" | sha256sum --check --status) || die 'Node.js checksum verification failed.'
    tar -xJf "$work_dir/$archive" -C "$work_dir"
    "$work_dir/$release/bin/node" --version
    run_root install -d -m 0755 "$NODE_DIR"
    run_root cp -a "$work_dir/$release" "$NODE_DIR/"
    run_root chown -R root:root "$NODE_DIR/$release"
  fi
  run_root ln -sfn "$NODE_DIR/$release" "$NODE_DIR/current"
  "$NODE_DIR/current/bin/node" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
}

# Quote a systemd string, including literal percent specifiers in checkout paths.
unit_string() {
  local value=$1
  [[ $value != *$'\n'* && $value != *$'\r'* ]] || die 'Paths containing newlines are unsupported.'
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

render_service() {
  local project data node line
  # WorkingDirectory takes the whole path literally, unlike Environment/ExecStart.
  project=${PROJECT_DIR//%/%%}
  data=$(unit_string "$data_dir")
  node=$(unit_string "$NODE_DIR/current/bin/node")
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line//@PROJECT_DIR@/"$project"}
    line=${line//@DATA_DIR@/"$data"}
    line=${line//@NODE@/"$node"}
    line=${line//@PORT@/"$port"}
    printf '%s\n' "$line"
  done < "$PROJECT_DIR/deploy/dmxcontrol@.service"
}

check_health() {
  local attempt response
  for attempt in {1..30}; do
    if systemctl is-active --quiet "$service" && \
      response=$(curl --fail --silent --show-error --max-time 2 --noproxy '*' "http://127.0.0.1:$port/api/health" 2>/dev/null) && \
      printf '%s' "$response" | "$NODE_DIR/current/bin/node" -e '
        let body = ""; process.stdin.on("data", chunk => body += chunk);
        process.stdin.on("end", () => { try {
          const health = JSON.parse(body);
          process.exit(health.ok === true && !health.persistenceError ? 0 : 1);
        } catch { process.exit(1); } });'; then
      return
    fi
    sleep 1
  done
  run_root journalctl -u "$service" -n 50 --no-pager >&2 || true
  die "The service did not become healthy on port $port. Check for another process using that port or a systemd override."
}

main() {
  local with_ola=false
  port=
  while (( $# )); do
    case $1 in
      --with-ola) with_ola=true; shift ;;
      --port) (( $# >= 2 )) || die '--port needs a value.'; port=$2; validate_port; shift 2 ;;
      -h|--help) usage; return ;;
      *) die "Unknown option: $1. Run ./install.sh --help." ;;
    esac
  done
  require_platform
  cd "$PROJECT_DIR"
  data_dir="$install_home/.local/share/dmxcontrol"
  if [[ -z $port && -f $data_dir/install-port ]]; then port=$(cat "$data_dir/install-port"); fi
  port=${port:-3000}
  validate_port
  service=$(systemd-escape --template=dmxcontrol@.service "$install_user")
  # Validate paths before making changes to the machine.
  unit_string "$PROJECT_DIR" >/dev/null
  unit_string "$data_dir" >/dev/null
  work_dir=$(mktemp -d)
  trap cleanup EXIT
  trap failed ERR

  run_root apt-get update
  local packages=(ca-certificates curl xz-utils libstdc++6 libatomic1)
  if $with_ola; then packages+=(ola); fi
  run_root apt-get install -y --no-install-recommends "${packages[@]}"
  install_node

  # Stop before npm ci replaces dependencies or local state is copied.
  if systemctl cat "$service" >/dev/null 2>&1; then run_root systemctl stop "$service"; fi
  printf 'Installing application dependencies…\n'
  run_as_user "$NODE_DIR/current/bin/node" "$NODE_DIR/current/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --no-audit --no-fund
  run_root install -d -m 0700 -o "$install_user" -g "$install_group" "$data_dir"
  if [[ ! -e $data_dir/state.json && -f $PROJECT_DIR/data/state.json ]]; then
    printf 'Importing existing local settings…\n'
    run_root install -m 0600 -o "$install_user" -g "$install_group" "$PROJECT_DIR/data/state.json" "$data_dir/state.json"
  fi
  render_service > "$work_dir/$service"
  run_root install -m 0644 "$work_dir/$service" "$UNIT_DIR/$service"
  run_root systemctl daemon-reload
  if $with_ola; then
    run_root systemctl enable --now olad.service
  fi
  run_root systemctl enable "$service"
  run_root systemctl restart "$service"
  check_health
  printf '%s\n' "$port" > "$work_dir/install-port"
  run_root install -m 0600 -o "$install_user" -g "$install_group" "$work_dir/install-port" "$data_dir/install-port"

  printf '\nDMX Control is running and enabled at boot.\n'
  printf 'Open http://<controller-ip>:%s from a browser on the same network.\n' "$port"
  printf 'Controller addresses: '; hostname -I || true
  printf 'Settings: %s/state.json\n' "$data_dir"
  printf 'Logs: sudo journalctl -u %s -f\n' "$service"
  if $with_ola; then printf 'OLA: http://<controller-ip>:9090 — patch the USB output to an OLA universe there.\n'; fi
  printf 'Outputs start disconnected. Connect them in the app; DMX connects in blackout.\n'
}

validate_port() {
  [[ $port =~ ^[1-9][0-9]{3,4}$ ]] && (( port >= 1024 && port <= 65535 )) || die 'Port must be an integer from 1024 to 65535.'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
