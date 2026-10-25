#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd "$PROJECT_DIR"

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
main() {
  case ${1:-} in
    -h|--help)
      printf 'Usage: ./update.sh [install options]\n\nPull origin/main (fast-forward only), then rerun install.sh and restart.\n'
      printf 'Settings and the saved HTTP port are preserved. See ./install.sh --help.\n'
      return ;;
  esac

  command -v git >/dev/null || die 'git is required.'
  (( EUID != 0 )) || die 'Run ./update.sh as the normal user who owns this checkout; install.sh will use sudo.'
  [[ $(git branch --show-current) == main ]] || die 'Updates require the main branch. Switch to main first.'
  git diff --quiet && git diff --cached --quiet || die 'Commit or stash tracked local changes before updating.'
  git remote get-url origin >/dev/null || die 'An origin remote is required.'

  printf 'Fetching updates from origin/main…\n'
  # Fetch separately so we can reject local commits as well as divergent history.
  git fetch origin main
  git merge-base --is-ancestor HEAD refs/remotes/origin/main || die 'Local main has commits outside origin/main. Resolve them before updating.'
  git merge --ff-only refs/remotes/origin/main
  exec "$PROJECT_DIR/install.sh" "$@"
}

# Parse the complete function before Git can replace this running script.
main "$@"
