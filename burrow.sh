#!/usr/bin/env bash
# RAPP Burrow — smallest on-device footprint that lets the in-browser vBrainstem
# (GitHub Copilot) run on THIS machine. No brainstem, no VS Code, no pip.
# Auto-installs Python if missing (like the RAPP installer), then runs.
#   curl -fsSL https://kody-w.github.io/vbrainstem/burrow.sh | bash
set -euo pipefail

DIR="$HOME/.rapp-burrow"
SRC="${BURROW_SRC:-https://kody-w.github.io/vbrainstem/burrow.py}"

find_python() {
  local cmd
  for cmd in python3.11 python3.12 python3.13 python3 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
      if "$cmd" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
        command -v "$cmd"; return 0
      fi
    fi
  done
  return 1
}

ensure_brew() {
  if command -v brew >/dev/null 2>&1; then return 0; fi
  if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; return 0; fi
  if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; return 0; fi
  echo "🕳️  Installing Homebrew (needed to install Python)…"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)" || true
  [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)" || true
}

install_python() {
  echo "🕳️  Python 3 not found — installing it…"
  if [ "$(uname -s)" = "Darwin" ]; then
    ensure_brew
    brew install python@3.11
    export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y python3
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y python3
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y python3
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm python
  else
    echo "Could not auto-install Python. Install Python 3 and re-run." >&2
    exit 1
  fi
}

PY="$(find_python || true)"
if [ -z "$PY" ]; then install_python; PY="$(find_python || true)"; fi
if [ -z "$PY" ]; then echo "Python 3 still not found after install — open a new terminal and re-run." >&2; exit 1; fi

mkdir -p "$DIR"
echo "🕳️  Fetching burrow…"
if command -v curl >/dev/null 2>&1; then curl -fsSL "$SRC" -o "$DIR/burrow.py"; else wget -qO "$DIR/burrow.py" "$SRC"; fi

echo "🕳️  Starting burrow on this machine ($(hostname))…"
exec "$PY" "$DIR/burrow.py"
