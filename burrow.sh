#!/usr/bin/env bash
# RAPP Burrow — smallest on-device footprint that lets the in-browser vBrainstem
# (GitHub Copilot) run on THIS machine. No brainstem, no VS Code, no pip.
#   curl -fsSL https://kody-w.github.io/vbrainstem/burrow.sh | bash
set -euo pipefail

DIR="$HOME/.rapp-burrow"
SRC="https://kody-w.github.io/vbrainstem/burrow.py"
PY="$(command -v python3 || command -v python || true)"

if [ -z "$PY" ]; then
  echo "RAPP Burrow needs Python 3." >&2
  echo "  macOS:   xcode-select --install   (or:  brew install python)" >&2
  echo "  Linux:   sudo apt-get install -y python3   (or your package manager)" >&2
  exit 1
fi

mkdir -p "$DIR"
echo "🕳️  Fetching burrow…"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SRC" -o "$DIR/burrow.py"
else
  wget -qO "$DIR/burrow.py" "$SRC"
fi

echo "🕳️  Starting burrow on this machine ($(hostname))…"
exec "$PY" "$DIR/burrow.py"
