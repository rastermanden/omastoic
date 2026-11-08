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

for dependency in bun omarchy ttfx systemctl jq python3 rsync; do
  command -v "$dependency" >/dev/null 2>&1 || { echo "$dependency is required; nothing was copied." >&2; exit 1; }
done
if [[ -L $target || -e $target/.git || $root == "$target" ]]; then
  echo "Refusing to overwrite a linked/Git-managed plugin or copy onto itself: $target" >&2
  exit 1
fi
if [[ -e $target ]] && ! jq -e --arg id "$plugin_id" '.id == $id' "$target/manifest.json" >/dev/null 2>&1; then
  echo "Refusing to overwrite an unrelated directory: $target" >&2
  exit 1
fi
mkdir -p "$target"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude .agents --exclude bun.lock --exclude '*.bak.*' \
  --exclude assets/sources --exclude assets/local --exclude assets/originals \
  --exclude assets/portraits \
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
