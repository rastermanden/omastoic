#!/usr/bin/env bash
# Manual install from a checkout, for people who did not use
# `omarchy plugin add`. Copies a clean tree into the Omarchy plugins
# directory, enables the service, and runs the same `omastoic setup`
# the shell service runs on first load.
set -euo pipefail

root="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
plugin_id="io.github.rastermanden.omastoic"
plugin_home="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins"
target="$plugin_home/$plugin_id"

command -v omarchy >/dev/null 2>&1 || { echo "omarchy is required (Omarchy 4+)." >&2; exit 1; }

if [[ -L $target ]]; then
  rm -f "$target"
fi
mkdir -p "$target"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude bun.lock --exclude '*.bak.*' \
  --exclude assets/sources --exclude assets/portraits \
  --exclude demo.mp4 --exclude preview.gif \
  "$root/" "$target/"
echo "→ $target"

omarchy plugin validate "$target"

if omarchy-shell shell ping >/dev/null 2>&1; then
  omarchy-shell shell rescanPlugins
  if omarchy plugin list --json 2>/dev/null | jq -e --arg id "$plugin_id" 'any(.[]; .id == $id and .enabled == true)' >/dev/null; then
    echo "→ $plugin_id already enabled"
  else
    omarchy plugin enable "$plugin_id"
  fi
else
  echo "→ shell not running; later: omarchy plugin enable $plugin_id"
fi

"$target/bin/omastoic" setup --on-first
