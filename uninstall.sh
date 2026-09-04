#!/usr/bin/env bash
set -euo pipefail

plugin_id="omastoic"
target="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/$plugin_id"

if [[ -x $target/bin/omastoic ]]; then
  "$target/bin/omastoic" uninstall
elif command -v omastoic >/dev/null 2>&1; then
  omastoic uninstall
fi

if command -v omarchy >/dev/null 2>&1; then
  omarchy plugin remove "$plugin_id" --yes 2>/dev/null || true
fi
rm -rf "$target"
echo "omastoic removed. Your quotes are still in ${XDG_CONFIG_HOME:-$HOME/.config}/omastoic/."
